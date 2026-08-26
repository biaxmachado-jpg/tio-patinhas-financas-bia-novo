import { Fragment, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { formatBRL } from "@/lib/currency";
import { Card } from "@/components/ui/card";
import { BarChart3, ChevronDown, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

type TxType = "income" | "expense";

interface UnifiedTransaction {
  id: string;
  date: Date;
  description: string;
  amount: number; // sempre positivo aqui — o sinal já virou "type"
  type: TxType;
  categoryId: number | null;
  source: "Conta Bancária" | "Cartão de Crédito";
  sourceName: string;
}

interface CategoryRow {
  key: string;
  categoryName: string;
  monthly: Record<string, number>;
  total: number;
  transactions: UnifiedTransaction[];
}

function monthKey(d: Date): string {
  return format(d, "yyyy-MM");
}

function monthLabel(key: string): string {
  // key é "yyyy-MM" — monta uma data no dia 1 só pra formatar o rótulo.
  const [year, month] = key.split("-").map(Number);
  return format(new Date(year, month - 1, 1), "MMM/yy", { locale: ptBR });
}

export default function ResumoMensal() {
  const transactionsQuery = trpc.transactions.list.useQuery({});
  const cardTransactionsQuery = trpc.creditCardTransactions.list.useQuery({});
  const categoriesQuery = trpc.categories.list.useQuery();
  const accountsQuery = trpc.bankAccounts.list.useQuery();
  const cardsQuery = trpc.creditCards.list.useQuery();

  const [expandedTotals, setExpandedTotals] = useState<Set<string>>(new Set());
  const [expandedMonthly, setExpandedMonthly] = useState<Set<string>>(new Set());

  const isLoading =
    transactionsQuery.isLoading ||
    cardTransactionsQuery.isLoading ||
    categoriesQuery.isLoading ||
    accountsQuery.isLoading ||
    cardsQuery.isLoading;

  const { months, incomeRows, expenseRows } = useMemo(() => {
    const categories = categoriesQuery.data ?? [];
    const accounts = accountsQuery.data ?? [];
    const cards = cardsQuery.data ?? [];
    const categoryById = new Map<number, any>(categories.map((c: any) => [c.id, c]));
    const accountById = new Map<number, any>(accounts.map((a: any) => [a.id, a]));
    const cardById = new Map<number, any>(cards.map((c: any) => [c.id, c]));

    const unified: UnifiedTransaction[] = [];

    // Contas bancárias: type já vem certo do banco (income/expense), valor
    // sempre positivo na coluna amount.
    for (const t of transactionsQuery.data ?? []) {
      const amount = Math.abs(parseFloat(String((t as any).amount ?? 0)));
      if (!amount) continue;
      unified.push({
        id: `bank-${(t as any).id}`,
        date: new Date((t as any).date),
        description: (t as any).description ?? "",
        amount,
        type: (t as any).type,
        categoryId: (t as any).categoryId ?? null,
        source: "Conta Bancária",
        sourceName: accountById.get((t as any).accountId)?.name ?? "Conta",
      });
    }

    // Cartão de crédito: não tem coluna "type" — o sinal do valor é quem
    // decide (negativo = estorno/crédito = income, positivo = compra =
    // expense). Ver server/routers.ts files.import.
    for (const t of cardTransactionsQuery.data ?? []) {
      const raw = parseFloat(String((t as any).amount ?? 0));
      const amount = Math.abs(raw);
      if (!amount) continue;
      unified.push({
        id: `card-${(t as any).id}`,
        date: new Date((t as any).date),
        description: (t as any).description ?? "",
        amount,
        type: raw < 0 ? "income" : "expense",
        categoryId: (t as any).categoryId ?? null,
        source: "Cartão de Crédito",
        sourceName: cardById.get((t as any).cardId)?.name ?? "Cartão",
      });
    }

    if (unified.length === 0) {
      return { months: [] as string[], incomeRows: [] as CategoryRow[], expenseRows: [] as CategoryRow[] };
    }

    // Todos os meses desde o início dos dados até o mês mais recente, sem
    // buraco — mesmo um mês sem nenhuma transação aparece como coluna
    // zerada, pra dar continuidade real à evolução.
    let minDate = unified[0].date;
    let maxDate = unified[0].date;
    for (const t of unified) {
      if (t.date < minDate) minDate = t.date;
      if (t.date > maxDate) maxDate = t.date;
    }
    const months: string[] = [];
    const cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const end = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
    while (cursor <= end) {
      months.push(monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const buildRows = (type: TxType): CategoryRow[] => {
      const byCategory = new Map<string, CategoryRow>();
      for (const t of unified) {
        if (t.type !== type) continue;
        const key = t.categoryId != null ? String(t.categoryId) : "none";
        let row = byCategory.get(key);
        if (!row) {
          const cat = t.categoryId != null ? categoryById.get(t.categoryId) : null;
          row = {
            key,
            categoryName: cat?.name ?? "Sem categoria",
            monthly: {},
            total: 0,
            transactions: [],
          };
          byCategory.set(key, row);
        }
        const mKey = monthKey(t.date);
        row.monthly[mKey] = (row.monthly[mKey] ?? 0) + t.amount;
        row.total += t.amount;
        row.transactions.push(t);
      }
      const rows = Array.from(byCategory.values());
      rows.sort((a, b) => b.total - a.total);
      for (const r of rows) r.transactions.sort((a, b) => b.date.getTime() - a.date.getTime());
      return rows;
    };

    return { months, incomeRows: buildRows("income"), expenseRows: buildRows("expense") };
  }, [transactionsQuery.data, cardTransactionsQuery.data, categoriesQuery.data, accountsQuery.data, cardsQuery.data]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <BarChart3 className="h-7 w-7 text-primary" />
            Resumo Mensal
          </h1>
          <p className="text-muted-foreground mt-1">
            Todas as receitas e despesas — contas bancárias e cartões de crédito juntos — classificadas por
            categoria, com a evolução mês a mês desde o início dos seus dados.
          </p>
        </div>

        {isLoading ? (
          <Card className="p-8 text-center text-muted-foreground">Carregando...</Card>
        ) : months.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            Ainda não há transações suficientes pra montar o resumo. Importe algumas faturas ou extratos primeiro.
          </Card>
        ) : (
          <>
            <TypeSection
              title="Receitas"
              icon={TrendingUp}
              accent="text-green-600"
              rows={incomeRows}
              months={months}
              expandedTotals={expandedTotals}
              expandedMonthly={expandedMonthly}
              onToggleTotals={(key) => toggle(expandedTotals, setExpandedTotals, key)}
              onToggleMonthly={(key) => toggle(expandedMonthly, setExpandedMonthly, key)}
            />
            <TypeSection
              title="Despesas"
              icon={TrendingDown}
              accent="text-red-600"
              rows={expenseRows}
              months={months}
              expandedTotals={expandedTotals}
              expandedMonthly={expandedMonthly}
              onToggleTotals={(key) => toggle(expandedTotals, setExpandedTotals, key)}
              onToggleMonthly={(key) => toggle(expandedMonthly, setExpandedMonthly, key)}
            />
          </>
        )}
      </div>
    </div>
  );
}

function TypeSection({
  title,
  icon: Icon,
  accent,
  rows,
  months,
  expandedTotals,
  expandedMonthly,
  onToggleTotals,
  onToggleMonthly,
}: {
  title: string;
  icon: typeof TrendingUp;
  accent: string;
  rows: CategoryRow[];
  months: string[];
  expandedTotals: Set<string>;
  expandedMonthly: Set<string>;
  onToggleTotals: (key: string) => void;
  onToggleMonthly: (key: string) => void;
}) {
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <section className="space-y-4">
      <h2 className={`text-xl font-semibold flex items-center gap-2 ${accent}`}>
        <Icon className="h-5 w-5" />
        {title}
        <span className="text-sm font-normal text-muted-foreground ml-1">({formatBRL(grandTotal)})</span>
      </h2>

      {rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Nenhuma transação de {title.toLowerCase()} encontrada.</Card>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Totais Gerais</h3>
            <CategoryTable
              rows={rows}
              months={null}
              accent={accent}
              expanded={expandedTotals}
              onToggle={onToggleTotals}
              idPrefix={`${title}-total`}
            />
          </div>

          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Evolução Mensal</h3>
            <CategoryTable
              rows={rows}
              months={months}
              accent={accent}
              expanded={expandedMonthly}
              onToggle={onToggleMonthly}
              idPrefix={`${title}-monthly`}
            />
          </div>
        </>
      )}
    </section>
  );
}

function CategoryTable({
  rows,
  months,
  accent,
  expanded,
  onToggle,
  idPrefix,
}: {
  rows: CategoryRow[];
  // null = só a coluna de total (visão "Totais Gerais"); array = uma coluna
  // por mês, seguida da coluna de total (visão "Evolução Mensal").
  months: string[] | null;
  accent: string;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  idPrefix: string;
}) {
  const columnTotals =
    months && months.length > 0
      ? months.map((m) => rows.reduce((sum, r) => sum + (r.monthly[m] ?? 0), 0))
      : [];
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm border-collapse min-w-max">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="text-left font-medium px-3 py-2 sticky left-0 bg-muted/40 z-10 whitespace-nowrap">
              Categoria
            </th>
            {months?.map((m) => (
              <th key={m} className="text-right font-medium px-3 py-2 whitespace-nowrap">
                {monthLabel(m)}
              </th>
            ))}
            <th className="text-right font-medium px-3 py-2 whitespace-nowrap">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowKey = `${idPrefix}-${row.key}`;
            const isOpen = expanded.has(rowKey);
            return (
              <Fragment key={rowKey}>
                <tr
                  className="border-b hover:bg-muted/30 cursor-pointer"
                  onClick={() => onToggle(rowKey)}
                >
                  <td className="px-3 py-2 sticky left-0 bg-background z-10 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="truncate">{row.categoryName}</span>
                    </div>
                  </td>
                  {months?.map((m) => (
                    <td key={m} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                      {row.monthly[m] ? formatBRL(row.monthly[m]) : <span className="text-muted-foreground">—</span>}
                    </td>
                  ))}
                  <td className={`text-right px-3 py-2 font-medium tabular-nums whitespace-nowrap ${accent}`}>
                    {formatBRL(row.total)}
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${rowKey}-detail`} className="border-b bg-muted/20">
                    <td colSpan={(months?.length ?? 0) + 2} className="px-3 py-2">
                      <div className="max-h-64 overflow-y-auto rounded border bg-background">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-muted/60">
                            <tr>
                              <th className="text-left font-medium px-2 py-1.5">Data</th>
                              <th className="text-left font-medium px-2 py-1.5">Descrição</th>
                              <th className="text-left font-medium px-2 py-1.5">Origem</th>
                              <th className="text-right font-medium px-2 py-1.5">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.transactions.map((t) => (
                              <tr key={t.id} className="border-t">
                                <td className="px-2 py-1.5 whitespace-nowrap">{format(t.date, "dd/MM/yyyy")}</td>
                                <td className="px-2 py-1.5">{t.description}</td>
                                <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                                  {t.source === "Conta Bancária" ? "🏦" : "💳"} {t.sourceName}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                                  {formatBRL(t.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold bg-muted/30">
            <td className="px-3 py-2 sticky left-0 bg-muted/30 z-10 whitespace-nowrap">Total</td>
            {columnTotals.map((v, i) => (
              <td key={i} className="text-right px-3 py-2 tabular-nums whitespace-nowrap">
                {formatBRL(v)}
              </td>
            ))}
            <td className={`text-right px-3 py-2 tabular-nums whitespace-nowrap ${accent}`}>{formatBRL(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </Card>
  );
}
