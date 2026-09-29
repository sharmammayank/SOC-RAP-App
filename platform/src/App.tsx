import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { supabaseConfigured } from "./lib/supabase";
import { SessionProvider, useSession } from "./lib/session";
import { Layout } from "./components/Layout";
import { Button, ErrorBox, Spinner } from "./components/ui";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";

const Dashboard = lazy(() => import("./pages/DashboardPage"));
const NewRun = lazy(() => import("./pages/NewRunPage"));
const RunPage = lazy(() => import("./pages/RunPage"));
const SlaConfig = lazy(() => import("./pages/SlaConfigPage"));
const Rules = lazy(() => import("./pages/RulesPage"));
const Analytics = lazy(() => import("./pages/AnalyticsPage"));
const Compare = lazy(() => import("./pages/ComparePage"));
const Exports = lazy(() => import("./pages/ExportsPage"));
const ClientSettings = lazy(() => import("./pages/ClientSettingsPage"));
const Admin = lazy(() => import("./pages/AdminPage"));
const Account = lazy(() => import("./pages/AccountPage"));

export function App() {
  if (!supabaseConfigured) return <SetupPage />;
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}

function Gate() {
  const { session, loading, error, refresh, signOut } = useSession();
  if (loading)
    return (
      <div className="grid h-screen place-items-center">
        <Spinner label="Signing in…" />
      </div>
    );
  if (!session) return <LoginPage />;
  if (error)
    return (
      <div className="mx-auto mt-24 flex max-w-xl flex-col gap-3 px-4">
        <ErrorBox error={error} onRetry={refresh} />
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
    );
  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/runs/new" element={<NewRun />} />
          <Route path="/runs/:id/*" element={<RunPage />} />
          <Route path="/config/sla" element={<SlaConfig />} />
          <Route path="/config/rules" element={<Rules />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/exports" element={<Exports />} />
          <Route path="/client" element={<ClientSettings />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
