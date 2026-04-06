import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "./lib/trpc";
import { createIdbPersister } from "./lib/offline/persister";
import App from "./App";
import "./index.css";

// 24 hours — how long unused query data is kept in the persisted cache
const GC_TIME_DEFAULT = 24 * 60 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      gcTime: GC_TIME_DEFAULT,
    },
  },
});

const persister = createIdbPersister();

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
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          // Max age for persisted cache: 24 hours.
          // Station pages override gcTime to Infinity for their critical queries.
          maxAge: GC_TIME_DEFAULT,
          // Dehydrate mutations too so pending offline mutations survive reload
          dehydrateOptions: {
            shouldDehydrateMutation: () => true,
          },
        }}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </PersistQueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
