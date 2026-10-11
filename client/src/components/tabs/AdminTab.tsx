import { useState } from "react";
import { Settings, Sparkles, Trash2, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { AdminUser, NewUserFormValues } from "@/types";

// ── New user dialog ───────────────────────────────────────────────────────────

interface NewUserDialogProps {
  onClose: () => void;
  onSave: (value: NewUserFormValues) => void;
  pending: boolean;
}

function NewUserDialog({ onClose, onSave, pending }: NewUserDialogProps) {
  const [value, setValue] = useState<NewUserFormValues>({
    username: "",
    password: "",
    name: "",
    role: "user",
  });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="new-contact-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
        <p className="eyebrow">New user</p>
        <h2>Add someone.</h2>
        <p className="dialog-copy">They can log in with these credentials immediately.</p>
        <div className="form-grid">
          <Input
            className="col-span-2"
            placeholder="Username (letters, numbers, _)"
            value={value.username}
            onChange={(e) =>
              setValue({ ...value, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })
            }
          />
          <Input
            className="col-span-2"
            placeholder="Display name"
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
          <Input
            className="col-span-2"
            type="password"
            placeholder="Password (min 12 chars)"
            autoComplete="new-password"
            value={value.password}
            onChange={(e) => setValue({ ...value, password: e.target.value })}
          />
          <select
            className="col-span-2 h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={value.role}
            onChange={(e) => setValue({ ...value, role: e.target.value as "user" | "admin" })}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button
          className="primary-button w-full mt-5"
          disabled={!value.username || value.password.length < 12 || pending}
          onClick={() => onSave(value)}
        >
          <UserPlus className="h-4 w-4" /> Create user
        </Button>
      </div>
    </div>
  );
}

// ── AdminTab (main export) ────────────────────────────────────────────────────

export function AdminTab() {
  const [showNew, setShowNew] = useState(false);
  const [resetUserId, setResetUserId] = useState<number | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);

  const utils = trpc.useUtils();

  const usersQuery = trpc.admin.listUsers.useQuery(undefined, { retry: false });

  const revokeSessions = trpc.admin.revokeSessions.useMutation({
    onSuccess: () => toast.success("Sessions revoked"),
    onError: (e) => toast.error(e.message),
  });

  const resetPassword = trpc.admin.resetPassword.useMutation({
    onSuccess: () => {
      toast.success("Password reset and sessions revoked");
      setResetUserId(null);
      setResetValue("");
    },
    onError: (e) => toast.error(e.message),
  });

  const createUser = trpc.admin.createUser.useMutation({
    onSuccess: () => {
      toast.success("User created");
      setShowNew(false);
      void utils.admin.listUsers.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      toast.success("User deleted");
      setDeleteTarget(null);
      void utils.admin.listUsers.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateRole = trpc.admin.updateRole.useMutation({
    onSuccess: () => {
      toast.success("Role updated");
      void utils.admin.listUsers.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="content-stack">
      {/* Inline password reset form */}
      {resetUserId !== null && (
        <Card className="surface-card">
          <CardContent className="flex gap-3 pt-5">
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="New password (at least 12 characters)"
              value={resetValue}
              onChange={(e) => setResetValue(e.target.value)}
            />
            <Button
              disabled={resetValue.length < 12 || resetPassword.isPending}
              onClick={() => resetPassword.mutate({ id: resetUserId, password: resetValue })}
            >
              Save password
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setResetUserId(null);
                setResetValue("");
              }}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="filter-row">
        <div>
          <p className="eyebrow">Admin</p>
          <h2 className="view-title">User Management</h2>
        </div>
        <Button className="primary-button" onClick={() => setShowNew(true)}>
          <UserPlus className="h-4 w-4" /> Add user
        </Button>
      </div>

      <Card className="surface-card">
        <CardContent className="p-0">
          {usersQuery.isLoading ? (
            <div className="loading-state">
              <Sparkles className="h-4 w-4 animate-pulse" />
              Loading users...
            </div>
          ) : usersQuery.data?.length ? (
            <div className="full-task-list">
              {(usersQuery.data as AdminUser[]).map((u) => (
                <div className="full-task-row" key={u.id}>
                  <div className="avatar avatar-soft text-xs">
                    {(u.name || u.email || "?")[0].toUpperCase()}
                  </div>
                  <div className="task-main">
                    <p>{u.name || "—"}</p>
                    <span>
                      {u.email || u.loginMethod} · Last signed in{" "}
                      {u.lastSignedIn
                        ? new Date(u.lastSignedIn).toLocaleDateString()
                        : "never"}
                    </span>
                  </div>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={u.role}
                    onChange={(e) =>
                      updateRole.mutate({ id: u.id, role: e.target.value as "user" | "admin" })
                    }
                    aria-label={`Role for ${u.name ?? u.email ?? "user"}`}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    className="text-action"
                    disabled={revokeSessions.isPending}
                    onClick={() => revokeSessions.mutate({ id: u.id })}
                  >
                    Revoke sessions
                  </button>
                  <button
                    className="text-action"
                    onClick={() => {
                      setResetUserId(u.id);
                      setResetValue("");
                    }}
                  >
                    Reset password
                  </button>
                  <button
                    className="text-action"
                    aria-label={`Delete user ${u.name ?? u.email ?? ""}`}
                    onClick={() => setDeleteTarget(u)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Users className="h-4 w-4" />
              </div>
              <p className="empty-title">No users yet</p>
              <p>Add a user to share this workspace.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* New user dialog */}
      {showNew && (
        <NewUserDialog
          onClose={() => setShowNew(false)}
          onSave={(v) => createUser.mutate(v)}
          pending={createUser.isPending}
        />
      )}

      {/* Delete user confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete user "${deleteTarget?.name ?? deleteTarget?.email}"?`}
        description="This will permanently remove their account and all associated data."
        confirmLabel="Delete user"
        destructive
        onConfirm={() => deleteTarget && deleteUser.mutate({ id: deleteTarget.id })}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
