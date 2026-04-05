import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "./lib/trpc";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

// In dev, Vite proxies /trpc → localhost:3002.
// In Docker, nginx proxies /trpc → localhost:3001.
// Override with VITE_API_URL for other setups.
const API_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/trpc`
  : "/trpc";

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: API_URL,
      headers() {
        // Extract the first path segment as the competition nameId.
        // e.g. /my_competition/dashboard → "my_competition"
        // Pages outside a competition (e.g. the selector) won't have a nameId.
        const match = window.location.pathname.match(/^\/([^/]+)/);
        const nameId = match?.[1];
        return nameId ? { "x-competition-id": nameId } : {};
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
