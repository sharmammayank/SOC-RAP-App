import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import "./styles/index.css";
import { App } from "./App";
import { TipProvider } from "./components/ui";
import { applyTheme } from "./lib/theme";

applyTheme();
const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TipProvider>
          <App />
          <Toaster position="bottom-right" richColors closeButton />
        </TipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
