import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Edit3, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, Paging, prettyDate } from "@/components/WorkspaceShared";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { Contact, TaskWithContact, TaskFilter, TaskFormValues, TaskEditValues } from "@/types";
import { X } from "lucide-react";

const PAGE_SIZE = 50;

// ── Task form dialog ──────────────────────────────────────────────────────────

interface TaskFormDialogProps {
  value: TaskFormValues | TaskEditValues;
  setValue: (v: TaskFormValues | TaskEditValues) => void;
  contacts: Contact[];
  onClose: () => void;
  onSave: () => void;
  editing?: boolean;
  pending?: boolean;
}

export function TaskFormDialog({
  value,
  setValue,
  contacts,
  onClose,
  onSave,
  editing = false,
  pending = false,
}: TaskFormDialogProps) {
  const [contactQuery, setContactQuery] = useState("");
  const searchQuery = useDebouncedValue(contactQuery.trim());

  const searchResults = trpc.contacts.search.useQuery(
    { query: searchQuery, limit: 20 },
    { enabled: searchQuery.length > 0 },
  );

  const selectedContact = trpc.contacts.get.useQuery(
    { id: Number(value.contactId) },
    { enabled: Boolean(value.contactId) },
  );

  // Merge: selected contact first, then search results, then fallback list, deduplicated
  const people: Contact[] = [
    ...(selectedContact.data ? [selectedContact.data as Contact] : []),
    ...(searchResults.data as Contact[] ?? contacts),
  ].filter(
    (person, index, all) => all.findIndex((item) => item.id === person.id) === index,
  );

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="new-contact-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
        <p className="eyebrow">{editing ? "Edit follow-up" : "New follow-up"}</p>
        <h2>{editing ? "Keep it current." : "Keep the thread going."}</h2>
        <p className="dialog-copy">Choose a person and give the promise a date.</p>
        <div className="form-grid">
          <Input
            className="col-span-2"
            placeholder="Search contacts by name or company"
            value={contactQuery}
            maxLength={240}
            onChange={(e) => setContactQuery(e.target.value)}
          />
          <select
            className="col-span-2 h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={value.contactId}
            onChange={(e) => setValue({ ...value, contactId: e.target.value })}
          >
            <option value="">Choose a contact</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.firstName} {person.lastName} · {person.company}
              </option>
            ))}
          </select>
          <Input
            className="col-span-2"
            placeholder="What needs to happen?"
            value={value.title}
            onChange={(e) => setValue({ ...value, title: e.target.value })}
          />
          <Input
            className="col-span-2"
            type="date"
            value={value.dueAt}
            onChange={(e) => setValue({ ...value, dueAt: e.target.value })}
          />
        </div>
        <Button
          className="primary-button w-full mt-5"
          onClick={onSave}
          disabled={pending || !value.contactId || !value.title.trim() || !value.dueAt}
        >
          <Plus className="h-4 w-4" />
          {editing ? "Save changes" : "Create follow-up"}
        </Button>
      </div>
    </div>
  );
}

// ── TasksTab (main export) ────────────────────────────────────────────────────

interface TasksTabProps {
  hubspotConnected: boolean;
}

export function TasksTab({ hubspotConnected }: TasksTabProps) {
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [page, setPage] = useState(0);
  const [showNewTask, setShowNewTask] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskEditValues | null>(null);

  // Reset page when filter changes
  useEffect(() => setPage(0), [filter]);

  const utils = trpc.useUtils();

  const tasksQuery = trpc.tasks.list.useQuery({
    filter,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  // We need a contact list for the task form dropdowns
  const contactsQuery = trpc.contacts.list.useQuery({ limit: 200 });

  const emptyTask: TaskFormValues = { contactId: "", title: "", dueAt: "" };

  const createTask = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Follow-up added");
      setShowNewTask(false);
      void utils.tasks.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
  });

  const updateTask = trpc.tasks.update.useMutation({
    onSuccess: () => {
      toast.success("Follow-up updated");
      setEditingTask(null);
      void utils.tasks.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
  });

  const toggleTask = trpc.tasks.toggle.useMutation({
    onSuccess: () => {
      void utils.tasks.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
  });

  const syncTask = trpc.integrations.syncTask.useMutation({
    onSuccess: () => toast.success("Follow-up synced to HubSpot"),
    onError: (error) => toast.error(error.message),
  });

  const handleSaveNew = () => {
    // This handler is used for new tasks only — we pass value down via closure
    // The actual logic is inside onSave prop
  };

  const handleCreate = (value: TaskFormValues) => {
    const dueAt = new Date(`${value.dueAt}T09:00:00`);
    if (!value.contactId || !value.title.trim() || Number.isNaN(dueAt.getTime())) {
      toast.error("Choose a contact, title, and valid due date");
      return;
    }
    createTask.mutate({ contactId: Number(value.contactId), title: value.title.trim(), dueAt });
  };

  const handleUpdate = (value: TaskEditValues) => {
    const dueAt = new Date(`${value.dueAt}T09:00:00`);
    if (!value.contactId || !value.title.trim() || Number.isNaN(dueAt.getTime())) {
      toast.error("Choose a contact, title, and valid due date");
      return;
    }
    updateTask.mutate({
      id: value.id,
      contactId: Number(value.contactId),
      title: value.title.trim(),
      dueAt,
    });
  };

  const tasks = (tasksQuery.data as TaskWithContact[]) ?? [];

  return (
    <>
      <div className="content-stack">
        <div className="filter-row">
          <div>
            <p className="eyebrow">Your commitments</p>
            <h2 className="view-title">Follow-ups</h2>
          </div>
          <div className="flex items-center gap-3">
            <Button className="primary-button" onClick={() => setShowNewTask(true)}>
              <Plus className="h-4 w-4" />
              Add follow-up
            </Button>
            <div className="segmented-control">
              {(["open", "overdue", "all"] as const).map((item) => (
                <button
                  className={filter === item ? "selected" : ""}
                  key={item}
                  onClick={() => setFilter(item)}
                >
                  {item === "open" ? "Open" : item === "overdue" ? "Overdue" : "All tasks"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Card className="surface-card">
          <CardContent className="p-0">
            {tasksQuery.isLoading ? (
              <div className="loading-state">
                <Sparkles className="h-4 w-4 animate-pulse" />
                Loading follow-ups...
              </div>
            ) : tasks.length ? (
              <div className="full-task-list">
                {tasks.map((row) => (
                  <div className="full-task-row" key={row.task.id}>
                    <button
                      className={`check-button ${row.task.status === "completed" ? "checked" : ""}`}
                      onClick={() =>
                        toggleTask.mutate({
                          id: row.task.id,
                          completed: row.task.status !== "completed",
                        })
                      }
                      aria-label="Toggle task"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <div className="task-main">
                      <p className={row.task.status === "completed" ? "task-complete" : ""}>
                        {row.task.title}
                      </p>
                      <span>
                        {row.contact?.firstName} {row.contact?.lastName} · {row.contact?.company}
                      </span>
                    </div>
                    <div
                      className={`due-label ${
                        new Date(row.task.dueAt) < new Date() && row.task.status === "open"
                          ? "overdue"
                          : ""
                      }`}
                    >
                      {row.task.status === "completed" ? "Completed" : prettyDate(row.task.dueAt)}
                    </div>
                    <button
                      className="text-action"
                      aria-label="Edit follow-up"
                      onClick={() =>
                        setEditingTask({
                          id: row.task.id,
                          contactId: String(row.task.contactId),
                          title: row.task.title,
                          dueAt: new Date(row.task.dueAt).toISOString().slice(0, 10),
                        })
                      }
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    {hubspotConnected && (
                      <button
                        className="text-action"
                        aria-label="Sync follow-up to HubSpot"
                        onClick={() => syncTask.mutate({ taskId: row.task.id })}
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="This view is clear"
                text="New follow-ups will appear here when you create them."
              />
            )}
          </CardContent>
        </Card>

        <Paging
          page={page}
          setPage={setPage}
          hasNext={tasks.length === PAGE_SIZE}
        />
      </div>

      {/* New task dialog */}
      {showNewTask && (
        <NewTaskWrapper
          contacts={(contactsQuery.data as Contact[]) ?? []}
          onClose={() => setShowNewTask(false)}
          onSave={handleCreate}
          pending={createTask.isPending}
        />
      )}

      {/* Edit task dialog */}
      {editingTask && (
        <EditTaskWrapper
          initial={editingTask}
          contacts={(contactsQuery.data as Contact[]) ?? []}
          onClose={() => setEditingTask(null)}
          onSave={handleUpdate}
          pending={updateTask.isPending}
        />
      )}
    </>
  );
}

// ── Wrappers that own form state ──────────────────────────────────────────────

function NewTaskWrapper({
  contacts,
  onClose,
  onSave,
  pending,
}: {
  contacts: Contact[];
  onClose: () => void;
  onSave: (v: TaskFormValues) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<TaskFormValues>({ contactId: "", title: "", dueAt: "" });
  return (
    <TaskFormDialog
      value={value}
      setValue={(v) => setValue(v as TaskFormValues)}
      contacts={contacts}
      onClose={onClose}
      onSave={() => onSave(value)}
      pending={pending}
    />
  );
}

function EditTaskWrapper({
  initial,
  contacts,
  onClose,
  onSave,
  pending,
}: {
  initial: TaskEditValues;
  contacts: Contact[];
  onClose: () => void;
  onSave: (v: TaskEditValues) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<TaskEditValues>(initial);
  return (
    <TaskFormDialog
      value={value}
      setValue={(v) => setValue(v as TaskEditValues)}
      contacts={contacts}
      onClose={onClose}
      onSave={() => onSave(value)}
      editing
      pending={pending}
    />
  );
}
