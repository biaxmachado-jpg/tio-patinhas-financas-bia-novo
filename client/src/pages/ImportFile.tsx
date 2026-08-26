"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Upload, ArrowLeft, Plus, Trash2, FileText, Loader2, CheckCircle, AlertCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { TransactionCategorizer, type TransactionWithCategory } from "@/components/TransactionCategorizer";
import { DescriptionBatchEditor } from "@/components/DescriptionBatchEditor";
import { DueDateConfirmDialog } from "@/components/DueDateConfirmDialog";
import { ACCEPTED_IMPORT_EXTENSIONS, readFileForClassification } from "@/lib/fileConversion";
import { takePendingImport } from "@/lib/importHandoff";

type ImportType = "creditCard" | "bankAccount";

interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: string;
  isDuplicate?: boolean;
  categoryId?: number;
  isInstallment?: boolean; // parcela (installments > 1, lido da fatura)
  aiType?: "income" | "expense"; // tipo já classificado pela IA (evita depender do sinal do valor)
  installments?: number; // total de parcelas, lido da notação impressa na fatura (ex: "03/10")
  currentInstallment?: number; // parcela atual cobrada nesta fatura
  categorySource?: "rule" | "ai"; // categoria veio de uma regra (Configurações) ou de sugestão da IA
}

// ─────────────────────────────────────────────────────────────────────────────
// Extrai ano e mês de referência da fatura pelo nome do arquivo
// Ex: "fatura-20260506master.csv" → { year: 2026, month: 4 } (mês anterior ao vencimento)
// Ex: "fatura-20260101visa.csv"   → { year: 2025, month: 12 }
// ─────────────────────────────────────────────────────────────────────────────
function extrairMesFatura(fileName: string): { year: number; month: number } | null {
  // Tenta pegar YYYYMMDD do nome do arquivo
  const match = fileName.match(/(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  const year = parseInt(match[1]);
  const month = parseInt(match[2]); // mês de vencimento
  // Mês de referência = mês anterior ao vencimento
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

// Decide se uma transação é parcela de mês anterior
// Regra: data da transação está entre 1 e 24 meses antes do mês de referência da fatura
function isParcelaAnterior(
  txDate: string,
  faturaRef: { year: number; month: number }
): boolean {
  const d = new Date(txDate + "T12:00:00");
  const txYear = d.getFullYear();
  const txMonth = d.getMonth() + 1;
  const diffMeses = (faturaRef.year - txYear) * 12 + (faturaRef.month - txMonth);
  // Parcela = entre 1 e 24 meses antes do mês da fatura
  return diffMeses >= 1 && diffMeses <= 24;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitário: extrai o sufixo de parcelamento "XX/YY" do final da descrição
// Ex: "SAMSUNG NO ITAU   02/21" → { base: "SAMSUNG NO ITAU", parcela: "02/21" }
// ─────────────────────────────────────────────────────────────────────────────
function extrairParcelamento(desc: string): { base: string; parcela: string | null } {
  // Padrão: 2 dígitos / 2 dígitos no final (com possíveis espaços antes)
  const match = desc.trim().match(/^(.*?)\s+(\d{2}\/\d{2})\s*$/);
  if (match) {
    return { base: match[1].trim(), parcela: match[2] };
  }
  return { base: desc.trim(), parcela: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: Verificação de duplicatas que respeita parcelamentos
// Parcelas com sufixo XX/YY diferente NUNCA são duplicatas entre si
// ─────────────────────────────────────────────────────────────────────────────
function isDuplicateTransaction(
  tx: { date: string; description: string; amount: string },
  existingDups: Array<{ date: string | Date; description: string; amount: string }>
): boolean {
  const { base: txBase, parcela: txParcela } = extrairParcelamento(tx.description);

  return existingDups.some(dup => {
    const { base: dupBase, parcela: dupParcela } = extrairParcelamento(dup.description);

    // Se ambas têm parcela e são diferentes → NÃO é duplicata
    if (txParcela !== null && dupParcela !== null && txParcela !== dupParcela) {
      return false;
    }

    const sameDate = new Date(dup.date).toISOString().split("T")[0] === tx.date;
    const sameAmount = dup.amount === tx.amount;
    // Compara a base da descrição (sem sufixo de parcela)
    const sameDesc = dupBase.toLowerCase() === txBase.toLowerCase();

    return sameDate && sameAmount && sameDesc;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────
export default function ImportFile() {
  const { cardId, accountId } = useParams();
  const [location, navigate] = useLocation();
  const importType: ImportType = location.startsWith("/cartoes/") ? "creditCard" : "bankAccount";
  const entityId = importType === "creditCard"
    ? parseInt(cardId || accountId || "0")
    : parseInt(accountId || cardId || "0");

  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [fromSmartImport, setFromSmartImport] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pendingTransactions, setPendingTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [aiProcessed, setAiProcessed] = useState(false);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [showCategorizer, setShowCategorizer] = useState(false);
  const [showDescriptionEditor, setShowDescriptionEditor] = useState(false);
  const [extractedDueDate, setExtractedDueDate] = useState<Date | null>(null);
  const [confirmedDueDate, setConfirmedDueDate] = useState<Date | null>(null);
  const [showDueDateConfirm, setShowDueDateConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cardQuery = trpc.creditCards.get.useQuery(
    { id: entityId },
    { enabled: importType === "creditCard" }
  );
  const accountQuery = trpc.bankAccounts.get.useQuery(
    { id: entityId },
    { enabled: importType === "bankAccount" }
  );

  const importMutation = trpc.files.import.useMutation();
  const classifyMutation = trpc.files.classifyWithAI.useMutation();
  const categoriesQuery = trpc.categories.list.useQuery();
  const utils = trpc.useUtils();

  const entity = importType === "creditCard" ? cardQuery.data : accountQuery.data;
  const isLoadingEntity = importType === "creditCard" ? cardQuery.isLoading : accountQuery.isLoading;

  // Handoff da importação inteligente (Importar.tsx): quando a IA já
  // identificou sozinha o cartão/conta e classificou o arquivo, chegamos
  // aqui com o resultado pronto — sem reclassificar (mais rápido, e evita
  // a IA dar uma resposta ligeiramente diferente numa segunda chamada).
  useEffect(() => {
    const handoff = takePendingImport();
    if (!handoff) return;
    setFileName(handoff.fileName);
    setFromSmartImport(true);
    void applyClassifiedResult(handoff.transactions, handoff.fileName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      const fileExtension = "." + selectedFile.name.split(".").pop()?.toLowerCase();

      if (!ACCEPTED_IMPORT_EXTENSIONS.includes(fileExtension)) {
        toast.error("Por favor, selecione um arquivo PDF, OFX, TXT, XLSX, XLS ou CSV");
        return;
      }
      if (selectedFile.size > 10 * 1024 * 1024) {
        toast.error("O arquivo não pode ser maior que 10MB");
        return;
      }

      setFile(selectedFile);
      setFileName(selectedFile.name);
      setFromSmartImport(false);
      setAiProcessed(false);
      setTransactions([]);
      setDuplicates([]);
      setShowDuplicateWarning(false);
      toast.success("Arquivo selecionado com sucesso!");
    }
  };

  const addTransaction = () => {
    const newTransaction: Transaction = {
      id: Date.now().toString(),
      date: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
    };
    setTransactions([...transactions, newTransaction]);
  };

  const updateTransaction = (id: string, field: keyof Transaction, value: string) => {
    setTransactions(transactions.map(tx =>
      tx.id === id ? { ...tx, [field]: value } : tx
    ));
  };

  const removeTransaction = (id: string) => {
    setTransactions(transactions.filter(tx => tx.id !== id));
  };

  // Recebe o resultado já classificado (de uma chamada fresca à IA ou de um
  // handoff da importação inteligente) e conduz o resto do fluxo: marca
  // parceladas, mostra o resumo, e segue pra confirmação de vencimento
  // (cartão) ou checagem de duplicatas (conta).
  const applyClassifiedResult = async (
    aiTransactions: Array<{
      date: string;
      description: string;
      amount: string;
      type: "income" | "expense";
      categoryId: number | null;
      installments?: number;
      currentInstallment?: number;
      categorySource?: "rule" | "ai";
    }>,
    sourceFileName: string
  ) => {
    const extractedTransactions: Transaction[] = aiTransactions.map((t, idx) => ({
      id: `${Date.now()}-${idx}-${Math.random()}`,
      date: t.date,
      description: t.description,
      amount: t.amount,
      categoryId: t.categoryId ?? undefined,
      aiType: t.type,
      installments: t.installments ?? 1,
      currentInstallment: t.currentInstallment ?? 1,
      categorySource: t.categorySource,
    }));

    if (extractedTransactions.length === 0) {
      toast.warning("Nenhuma transação encontrada no arquivo. Tente adicionar manualmente.");
      return;
    }

    // Parcelada = o que está escrito na própria fatura (installments > 1,
    // extraído pela IA da notação "03/10" etc.), não mais um chute pela
    // data do arquivo. Mantemos o heurístico antigo só como reforço, pra
    // fatura/texto onde a IA não tenha achado a notação de parcela.
    const faturaRef = extrairMesFatura(sourceFileName);
    const markedTransactions = extractedTransactions.map(tx => ({
      ...tx,
      isInstallment:
        (tx.installments ?? 1) > 1 ||
        (faturaRef ? isParcelaAnterior(tx.date, faturaRef) : false),
    }));

    setTransactions(markedTransactions);
    setPendingTransactions(markedTransactions);
    setExtractedDueDate(null);
    setAiProcessed(true);

    const isCardImport = importType === "creditCard";
    const creditosCount = isCardImport ? markedTransactions.filter(t => t.aiType === "income").length : 0;
    const comprasMes = markedTransactions.filter(t => !t.isInstallment && t.aiType !== "income").length;
    const parcelas = markedTransactions.filter(t => t.isInstallment && t.aiType !== "income").length;
    const regrasCount = markedTransactions.filter(t => t.categorySource === "rule").length;
    toast.success(
      `${markedTransactions.length} transação(ões) classificada(s) por IA: ${comprasMes} do mês` +
        (parcelas > 0 ? `, ${parcelas} parcela(s)` : "") +
        (creditosCount > 0 ? `, ${creditosCount} crédito(s)/estorno(s)` : "") +
        (regrasCount > 0 ? ` — ${regrasCount} categorizada(s) pelas suas regras` : "")
    );

    if (importType === "creditCard") {
      setShowDueDateConfirm(true);
    } else {
      await checkForDuplicates(extractedTransactions);
    }
  };

  const handleProcessFile = async () => {
    if (!file) {
      toast.error("Por favor, selecione um arquivo primeiro");
      return;
    }

    setIsLoading(true);
    try {
      const { pdfBase64, textContent } = await readFileForClassification(file);

      // A IA lê o arquivo (PDF nativo ou texto), extrai as transações e já
      // sugere tipo (receita/despesa) e categoria com base nas suas regras
      // e no seu histórico.
      const result = await classifyMutation.mutateAsync({
        entityType: importType,
        fileName: file.name,
        pdfBase64,
        textContent,
      });

      await applyClassifiedResult(result.transactions, file.name);
    } catch (error) {
      console.error("Erro ao processar arquivo:", error);
      toast.error("Erro ao processar arquivo: " + (error instanceof Error ? error.message : "Erro desconhecido"));
    } finally {
      setIsLoading(false);
    }
  };

  const checkForDuplicates = async (txs: Transaction[]) => {
    try {
      const result = await utils.files.checkDuplicates.fetch({
        entityType: importType,
        entityId,
        transactions: txs.map((tx) => ({
          date: new Date(tx.date),
          description: tx.description,
          amount: tx.amount,
        })),
      });

      let updatedTxs = txs;

      if (result && result.duplicates && result.duplicates.length > 0) {
        // ── FIX 2: Aplicar lógica de parcelamento na marcação de duplicatas ────
        updatedTxs = txs.map((tx) => ({
          ...tx,
          isDuplicate: isDuplicateTransaction(tx, result.duplicates),
        }));

        const realDuplicates = updatedTxs.filter(tx => tx.isDuplicate);
        setTransactions(updatedTxs);
        setDuplicates(result.duplicates);

        if (realDuplicates.length > 0) {
          setShowDuplicateWarning(true);
          toast.warning(
            `${realDuplicates.length} transação(ões) pode(m) ser duplicada(s). Revise antes de importar.`
          );
        } else {
          setShowDuplicateWarning(false);
        }
      } else {
        setDuplicates([]);
        setShowDuplicateWarning(false);
      }

      // ── FIX 3: Abrir categorizer automaticamente após checar duplicatas ─────
      setShowCategorizer(true);

    } catch (error) {
      console.error("Erro ao verificar duplicatas:", error);
      // Mesmo com erro, abre o categorizer
      setShowCategorizer(true);
    }
  };

  const handleCategoriesApplied = async (categorizedTransactions: TransactionWithCategory[]) => {
    setTransactions(categorizedTransactions);
    setShowCategorizer(false);
    // Importar direto com as transações categorizadas (não depende do estado assíncrono)
    await handleImportWithTransactions(categorizedTransactions);
  };

  const handleDescriptionsNormalized = (normalizedTransactions: Transaction[]) => {
    setTransactions(normalizedTransactions);
    setShowDescriptionEditor(false);
    toast.success("Descrições normalizadas com sucesso!");
  };

  const handleImportWithTransactions = async (txs: TransactionWithCategory[]) => {
    if (txs.length === 0) {
      toast.error("Nenhuma transação para importar");
      return;
    }

    for (const tx of txs) {
      if (!tx.date || !tx.description || !tx.amount) {
        toast.error("Por favor, preencha todos os campos de cada transação");
        return;
      }
      if (isNaN(parseFloat(tx.amount))) {
        toast.error("O valor deve ser um número válido");
        return;
      }
    }

    setIsLoading(true);
    try {
      const formattedTransactions = txs.map(tx => {
        const raw = parseFloat(tx.amount);
        // Se a IA já classificou o tipo na importação, usa isso — é mais confiável
        // do que inferir pelo sinal do valor. Fallback (transações adicionadas
        // manualmente, sem passar pela IA):
        // Cartão: positivo = compra (expense), negativo = estorno/devolução (income)
        // Conta: positivo = entrada (income), negativo = saída (expense)
        const type: "income" | "expense" = tx.aiType ?? (
          importType === "creditCard"
            ? (raw >= 0 ? "expense" : "income")
            : (raw >= 0 ? "income" : "expense")
        );
        // Fatura de cartão não tem coluna "type" no banco — o sinal do
        // valor é quem diferencia estorno/crédito (negativo) de compra
        // (positivo) nas telas que consomem a tabela (ver
        // transactionClassifier.ts). Sem isso, todo estorno virava despesa
        // positiva e nunca aparecia como crédito.
        const amount =
          importType === "creditCard"
            ? (type === "income" ? -Math.abs(raw) : Math.abs(raw)).toFixed(2)
            : Math.abs(raw).toFixed(2);
        return {
          date: new Date(tx.date),
          description: tx.description,
          amount,
          type,
          ...(tx.categoryId ? { categoryId: tx.categoryId } : {}),
          ...(importType === "creditCard"
            ? { installments: tx.installments ?? 1, currentInstallment: tx.currentInstallment ?? 1 }
            : {}),
        };
      });

      console.log("[Import] Enviando", formattedTransactions.length, "transações");
      console.log("[Import] Exemplo:", formattedTransactions[0]);

      // Arquivo XLS/binário não pode ser lido como texto — manda vazio.
      // Também vazio quando veio da importação inteligente (handoff): já
      // não temos o File original em mãos, só as transações já classificadas.
      const isBinary = fileName.match(/\.(xls|xlsx)$/i);
      const fileContent = isBinary || !file ? "" : await file.text();

      const result = await importMutation.mutateAsync({
        entityType: importType,
        entityId,
        fileContent,
        fileName: fileName || "manual-import",
        fileType: file?.type || "text/plain",
        transactions: formattedTransactions,
        dueDate: confirmedDueDate || undefined,
      });

      console.log("[Import] Resultado:", result);

      if (result.success) {
        toast.success(`${result.transactionsImported} transações importadas com sucesso!`);
        // Algumas transações podem ter sido puladas (data inválida, valor
        // inválido, ou — a mais comum — data no futuro, sinal de erro de
        // extração). Sem isso, a pessoa nunca fica sabendo que algo foi
        // ignorado silenciosamente.
        if (result.errors && result.errors.length > 0) {
          toast.warning(
            `${result.errors.length} transação(ões) foram ignoradas: ${result.errors.join("; ")}`,
            { duration: 10000 }
          );
        }
        setTimeout(() => {
          navigate(importType === "creditCard" ? `/cartoes/${entityId}` : `/contas/${entityId}`);
        }, 1000);
      }
    } catch (error) {
      console.error("[Import] Erro:", error);
      toast.error("Erro ao importar transações: " + (error instanceof Error ? error.message : "Erro desconhecido"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    await handleImportWithTransactions(transactions);
  };

  if (isLoadingEntity) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p>Carregando...</p>
        </div>
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="p-6 text-center">
          <p className="text-red-600 mb-4">Entidade não encontrada</p>
          <Button onClick={() => navigate("/")} variant="outline">Voltar</Button>
        </Card>
      </div>
    );
  }

  if (showDescriptionEditor && transactions.length > 0) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-4 mb-6">
            <Button variant="ghost" size="icon" onClick={() => setShowDescriptionEditor(false)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">Normalizar Descrições</h1>
          </div>
          <DescriptionBatchEditor
            transactions={transactions}
            onApplyTransformations={handleDescriptionsNormalized}
            onCancel={() => setShowDescriptionEditor(false)}
          />
        </div>
      </div>
    );
  }

  // Tela de categorização — import dispara automaticamente ao clicar "Salvar Categorias"
  if (showCategorizer && transactions.length > 0) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-4 mb-6">
            <Button variant="ghost" size="icon" onClick={() => setShowCategorizer(false)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold">Categorizar Transações</h1>
              <p className="text-muted-foreground text-sm mt-1">
                {transactions.length} transação(ões) • {transactions.filter(t => t.isDuplicate).length > 0
                  ? `${transactions.filter(t => t.isDuplicate).length} possível(is) duplicata(s) marcada(s)`
                  : "Nenhuma duplicata detectada"}
              </p>
            </div>
          </div>
          <TransactionCategorizer
            transactions={transactions}
            onCategoriesApplied={handleCategoriesApplied}
            onCancel={() => setShowCategorizer(false)}
            entityType={importType}
          />
        </div>
      </div>
    );
  }

  const fileExtension = file?.name.split(".").pop()?.toLowerCase() ?? "";
  const canProcess = ["xlsx", "xls", "pdf", "csv"].includes(fileExtension);

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(importType === "creditCard" ? `/cartoes/${entityId}` : `/contas/${entityId}`)}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Importar Transações</h1>
            <p className="text-muted-foreground">
              {importType === "creditCard" ? `Cartão: ${entity.name}` : `Conta: ${entity.name}`}
            </p>
          </div>
        </div>

        {fromSmartImport ? (
          <Card className="p-4 mb-6 flex items-center gap-3 bg-purple-50 border-purple-200">
            <Sparkles className="h-5 w-5 text-purple-600 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{fileName}</p>
              <p className="text-xs text-muted-foreground">
                Detectado e classificado automaticamente pela Importação Inteligente
              </p>
            </div>
          </Card>
        ) : (
          /* File Upload Section */
          <Card className="p-6 mb-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Upload de Arquivo (Opcional)
                </label>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.ofx,.txt,.xlsx,.xls,.csv"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full"
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      {file ? file.name : "Selecionar arquivo"}
                    </Button>
                  </div>
                  {file && (
                    <div className="text-sm text-green-600 flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Selecionado
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Formatos aceitos: PDF, XLSX, XLS, CSV, OFX, TXT
                </p>
              </div>

              {file && canProcess && (
                <div className="space-y-2">
                  <Button
                    onClick={handleProcessFile}
                    disabled={isLoading}
                    className="w-full bg-blue-600 hover:bg-blue-700"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Processando...
                      </>
                    ) : (
                      <>Carregar Transações do Arquivo</>
                    )}
                  </Button>
                  {aiProcessed && (
                    <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-2 rounded">
                      <CheckCircle className="h-4 w-4" />
                      <span>Transações classificadas por IA ✨</span>
                    </div>
                  )}
                  {showDuplicateWarning && duplicates.length > 0 && (
                    <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 p-3 rounded border border-amber-200">
                      <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="font-semibold">{duplicates.length} transação(ões) pode(m) ser duplicada(s)</p>
                        <p className="text-xs mt-1">Verifique as transações marcadas antes de importar</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Transactions Table */}
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Transações</h2>
            <div className="flex gap-2">
              {transactions.length > 0 && (
                <>
                  <Button
                    onClick={() => setShowDescriptionEditor(true)}
                    size="sm"
                    variant="outline"
                    className="text-blue-600 border-blue-200 hover:bg-blue-50"
                  >
                    Normalizar Descrições
                  </Button>
                  <Button
                    onClick={() => setShowCategorizer(true)}
                    size="sm"
                    variant="outline"
                    className="text-purple-600 border-purple-200 hover:bg-purple-50"
                  >
                    Categorizar
                  </Button>
                </>
              )}
              <Button onClick={addTransaction} size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Adicionar Transação
              </Button>
            </div>
          </div>

          {transactions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>Nenhuma transação adicionada ainda.</p>
              <p className="text-sm">Clique em "Adicionar Transação" para começar.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-2">Data</th>
                    <th className="text-left py-2 px-2">Descrição</th>
                    <th className="text-right py-2 px-2">Valor</th>
                    <th className="text-center py-2 px-2">Status</th>
                    <th className="text-center py-2 px-2">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr
                      key={tx.id}
                      className={`border-b hover:bg-muted/50 ${tx.isDuplicate ? "bg-amber-50" : ""}`}
                    >
                      <td className="py-2 px-2">
                        <Input
                          type="date"
                          value={tx.date}
                          onChange={(e) => updateTransaction(tx.id, "date", e.target.value)}
                          className="h-8"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <Input
                          type="text"
                          placeholder="Descrição"
                          value={tx.description}
                          onChange={(e) => updateTransaction(tx.id, "description", e.target.value)}
                          className="h-8"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <Input
                          type="number"
                          placeholder="0.00"
                          value={tx.amount}
                          onChange={(e) => updateTransaction(tx.id, "amount", e.target.value)}
                          className="h-8 text-right"
                          step="0.01"
                        />
                      </td>
                      <td className="py-2 px-2 text-center">
                        {tx.isDuplicate ? (
                          <div className="flex items-center justify-center gap-1 text-xs text-amber-600 bg-amber-100 px-2 py-1 rounded">
                            <AlertCircle className="h-3 w-3" />
                            Duplicada
                          </div>
                        ) : tx.categoryId ? (
                          <div className="flex items-center justify-center gap-1 text-xs text-green-600 bg-green-100 px-2 py-1 rounded">
                            <CheckCircle className="h-3 w-3" />
                            Categorizada
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeTransaction(tx.id)}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 mt-6">
            <Button
              variant="outline"
              onClick={() => navigate(importType === "creditCard" ? `/cartoes/${entityId}` : `/contas/${entityId}`)}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleImport}
              disabled={isLoading || transactions.length === 0}
              className="flex-1"
            >
              {isLoading
                ? "Importando..."
                : `Importar ${transactions.length} Transação${transactions.length !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </Card>
      </div>

      {/* DueDate Confirmation Dialog */}
      {showDueDateConfirm && importType === "creditCard" && (
        <DueDateConfirmDialog
          extractedDate={extractedDueDate}
          bankName="Cartão"
          onConfirm={(date) => {
            setConfirmedDueDate(date);
            setShowDueDateConfirm(false);
            checkForDuplicates(pendingTransactions);
          }}
          onCancel={() => {
            setShowDueDateConfirm(false);
            setConfirmedDueDate(null);
            checkForDuplicates(pendingTransactions);
          }}
        />
      )}
    </div>
  );
}
