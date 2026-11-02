import { trpc } from "@/lib/trpc";
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useAuth() {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const [loggingOut, setLoggingOut] = useState(false);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Sign out failed");
      utils.auth.me.setData(undefined, null);
      queryClient.clear();
    } finally {
      setLoggingOut(false);
    }
  }, [queryClient, utils]);

  const state = useMemo(() => ({
    user: meQuery.data ?? null,
    loading: meQuery.isLoading || loggingOut,
    error: meQuery.error ?? null,
    isAuthenticated: Boolean(meQuery.data),
  }), [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    loggingOut,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
