import { trpc } from "@/lib/trpc";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError(error, _variables, _context, mutation) {
      if (!mutation.options.onError) toast.error(error instanceof TRPCClientError ? error.message : "The change could not be saved. Please try again.");
    },
  }),
});

// In local mode, UNAUTHORIZED errors don't redirect — the login screen
// is shown inline by the Home component when user is null.
queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    if (error instanceof TRPCClientError && error.data?.code !== "UNAUTHORIZED") {
      console.error("[API Query Error]", error.data?.code ?? "Request failed");
    }
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    if (error instanceof TRPCClientError && error.data?.code !== "UNAUTHORIZED") {
      console.error("[API Mutation Error]", error.data?.code ?? "Request failed");
    }
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
