/**
 * Renders a React component wrapped in all providers required by the app
 * (tRPC + React Query). tRPC calls are not mocked here — tests that need
 * controlled server responses should mock fetch() directly or use
 * vi.mock("@/lib/trpc", ...).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { render, type RenderOptions } from "@testing-library/react";
import React, { type ReactElement } from "react";
import { trpc } from "@/lib/trpc";
import superjson from "superjson";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Turn off retries in tests so failures surface immediately.
        retry: false,
        staleTime: Infinity,
      },
    },
  });
}

function AllProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(makeQueryClient);
  const [trpcClient] = React.useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "http://localhost:3000/api/trpc",
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}
