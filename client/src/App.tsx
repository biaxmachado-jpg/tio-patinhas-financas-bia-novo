import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import Categories from "./pages/Categories";
import BankAccounts from "./pages/BankAccounts";
import BankAccountDetail from "./pages/BankAccountDetail";
import Transactions from "./pages/Transactions";
import Budgets from "./pages/Budgets";
import CreditCards from "./pages/CreditCards";
import CreditCardDetail from "./pages/CreditCardDetail";
import ImportFile from "./pages/ImportFile";
import Importar from "./pages/Importar";
import Profile from "./pages/Profile";
import Database from "./pages/Database";
import Expenses from "./pages/Expenses";
import Income from "./pages/Income";
import ResumoMensal from "./pages/ResumoMensal";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <DashboardLayout>
          <Dashboard />
        </DashboardLayout>
      </Route>
      <Route path="/categorias">
        <DashboardLayout>
          <Categories />
        </DashboardLayout>
      </Route>
      <Route path="/contas">
        <DashboardLayout>
          <BankAccounts />
        </DashboardLayout>
      </Route>
      <Route path="/contas/:accountId">
        <DashboardLayout>
          <BankAccountDetail />
        </DashboardLayout>
      </Route>
      <Route path="/despesas">
        <DashboardLayout>
          <Expenses />
        </DashboardLayout>
      </Route>
      <Route path="/receitas">
        <DashboardLayout>
          <Income />
        </DashboardLayout>
      </Route>
      <Route path="/orcamentos">
        <DashboardLayout>
          <Budgets />
        </DashboardLayout>
      </Route>
      <Route path="/resumo-mensal">
        <DashboardLayout>
          <ResumoMensal />
        </DashboardLayout>
      </Route>
      <Route path="/cartoes">
        <DashboardLayout>
          <CreditCards />
        </DashboardLayout>
      </Route>
      <Route path="/cartoes/:cardId/importar">
        <DashboardLayout>
          <ImportFile />
        </DashboardLayout>
      </Route>
      <Route path="/cartoes/:cardId">
        <DashboardLayout>
          <CreditCardDetail />
        </DashboardLayout>
      </Route>
      <Route path="/contas/:accountId/importar">
        <DashboardLayout>
          <ImportFile />
        </DashboardLayout>
      </Route>
      <Route path="/contas/:accountId">
        <DashboardLayout>
          <BankAccountDetail />
        </DashboardLayout>
      </Route>
      <Route path="/perfil">
        <DashboardLayout>
          <Profile />
        </DashboardLayout>
      </Route>
      <Route path="/banco-de-dados">
        <DashboardLayout>
          <Database />
        </DashboardLayout>
      </Route>
      <Route path="/importar">
        <DashboardLayout>
          <Importar />
        </DashboardLayout>
      </Route>
      {/* Link antigo do menu (era "Importar OFX") — mantido pra não quebrar
          favoritos salvos, agora mandando pra tela de importação de verdade. */}
      <Route path="/importar-ofx">
        <Redirect to="/importar" />
      </Route>
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
