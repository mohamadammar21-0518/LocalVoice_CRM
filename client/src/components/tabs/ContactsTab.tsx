import { useState, useEffect } from "react";
import { ArrowUpRight, CirclePlus, Edit3, Plus, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, Paging, initials, prettyTime } from "@/components/WorkspaceShared";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { Contact, Interaction, ContactFormValues, ContactEditValues } from "@/types";

const PAGE_SIZE = 50;

// ── Contact grid ──────────────────────────────────────────────────────────────

interface ContactGridProps {
  contacts: Contact[];
  loading: boolean;
  query: string;
  setQuery: (q: string) => void;
  onSelect: (id: number) => void;
  onAdd: () => void;
}

function ContactGrid({
  contacts,
  loading,
  query,
  setQuery,
  onSelect,
  onAdd,
}: ContactGridProps) {
  return (
    <div className="content-stack">
      <div className="view-toolbar">
        <div className="search-wrap">
          <Search className="h-4 w-4" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people, companies, roles..."
          />
        </div>
        <Button className="primary-button" onClick={onAdd}>
          <CirclePlus className="h-4 w-4" />
          New contact
        </Button>
      </div>
      <Card className="surface-card">
        <CardContent className="p-0">
          {loading ? (
            <div className="loading-state">
              <Sparkles className="h-4 w-4 animate-pulse" />
              Loading your contacts...
            </div>
          ) : contacts.length ? (
            <div className="contact-grid">
              {contacts.map((person) => (
                <button
                  className="contact-card"
                  key={person.id}
                  onClick={() => onSelect(person.id)}
                >
                  <div className="contact-card-top">
                    <div className="avatar avatar-lavender">
                      {initials(person.firstName, person.lastName)}
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <h3>
                    {person.firstName} {person.lastName}
                  </h3>
                  <p>{person.role || "Contact"}</p>
                  <span>{person.company || "Independent"}</span>
                  <div className="contact-divider" />
                  <small>{person.email || "No email added"}</small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No contacts match that search"
              text="Try a different name or add someone new."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Contact drawer ────────────────────────────────────────────────────────────

interface ContactDrawerProps {
  contact: Contact | null | undefined;
  interactions: Interaction[];
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSync: () => void;
  syncing: boolean;
  hubspotConnected: boolean;
  timelinePage: number;
  setTimelinePage: (p: number) => void;
}

function ContactDrawer({
  contact,
  interactions,
  onClose,
  onEdit,
  onDelete,
  onSync,
  syncing,
  hubspotConnected,
  timelinePage,
  setTimelinePage,
}: ContactDrawerProps) {
  const [newNote, setNewNote] = useState("");
  const utils = trpc.useUtils();

  const addNote = trpc.interactions.create.useMutation({
    onSuccess: () => {
      toast.success("Note saved to timeline");
      setNewNote("");
      void utils.interactions.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
  });

  const syncNote = trpc.integrations.syncNote.useMutation({
    onSuccess: () => toast.success("Note synced to HubSpot"),
    onError: (error) => toast.error(error.message),
  });

  const interactionsQuery = trpc.interactions.list.useQuery(
    { contactId: contact?.id, limit: PAGE_SIZE, offset: timelinePage * PAGE_SIZE },
    { enabled: Boolean(contact) },
  );

  // Reset timeline page when contact changes
  useEffect(() => {
    setTimelinePage(0);
  }, [contact?.id, setTimelinePage]);

  if (!contact) return null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="contact-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>

        {/* Identity */}
        <div className="drawer-identity">
          <div className="avatar avatar-lavender avatar-large">
            {initials(contact.firstName, contact.lastName)}
          </div>
          <p className="eyebrow">Contact profile</p>
          <h2>
            {contact.firstName} {contact.lastName}
          </h2>
          <p>
            {contact.role} · {contact.company}
          </p>
          <div className="drawer-contact-line">
            {contact.email || "No email"} · {contact.phone || "No phone"}
          </div>
          <div className="drawer-actions">
            <button className="text-action mt-4" onClick={onEdit}>
              <Edit3 className="h-3.5 w-3.5" />
              Edit contact
            </button>
            {hubspotConnected && (
              <button className="text-action mt-4" onClick={onSync} disabled={syncing}>
                <ArrowUpRight className="h-3.5 w-3.5" />
                {syncing ? "Syncing…" : contact.hubspotId ? "Update HubSpot" : "Sync to HubSpot"}
              </button>
            )}
            <button className="text-action mt-4 text-destructive" onClick={onDelete}>
              <X className="h-3.5 w-3.5" />
              Delete contact
            </button>
          </div>
        </div>

        {/* Add note */}
        <div className="drawer-section">
          <p className="eyebrow">Add to timeline</p>
          <Textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Capture a detail, promise, or next step..."
          />
          <div className="drawer-button-row">
            <Button
              className="secondary-button w-full"
              disabled={!newNote.trim() || addNote.isPending}
              onClick={() =>
                addNote.mutate({ contactId: contact.id, body: newNote, kind: "note" })
              }
            >
              <Plus className="h-4 w-4" />
              Save note
            </Button>
          </div>
        </div>

        {/* Timeline */}
        <div className="drawer-section">
          <p className="eyebrow">Timeline</p>
          {interactionsQuery.isLoading ? (
            <div className="loading-state">
              <Sparkles className="h-4 w-4 animate-pulse" />
              Loading timeline...
            </div>
          ) : interactions.length ? (
            <div className="timeline">
              {interactions.map((item) => (
                <div className="timeline-item" key={item.id}>
                  <div className="timeline-dot" />
                  <div>
                    <p>{item.body}</p>
                    <span>
                      {item.kind} · {prettyTime(item.occurredAt)}
                    </span>
                  </div>
                  {hubspotConnected && (
                    <button
                      className="text-action timeline-sync"
                      onClick={() => syncNote.mutate({ interactionId: item.id })}
                      aria-label="Sync interaction to HubSpot"
                    >
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No interactions yet"
              text="Your next note will begin this timeline."
            />
          )}
          <Paging
            page={timelinePage}
            setPage={setTimelinePage}
            hasNext={interactions.length === PAGE_SIZE}
          />
        </div>
      </aside>
    </div>
  );
}

// ── Contact form dialog ───────────────────────────────────────────────────────

interface ContactFormDialogProps {
  value: ContactFormValues | ContactEditValues;
  setValue: (v: ContactFormValues | ContactEditValues) => void;
  onClose: () => void;
  onSave: () => void;
  editing?: boolean;
  pending?: boolean;
}

export function ContactFormDialog({
  value,
  setValue,
  onClose,
  onSave,
  editing = false,
  pending = false,
}: ContactFormDialogProps) {
  const update =
    (key: keyof ContactFormValues) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setValue({ ...value, [key]: e.target.value });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="new-contact-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
        <p className="eyebrow">{editing ? "Edit contact" : "New contact"}</p>
        <h2>{editing ? "Keep it current." : "Make a little room."}</h2>
        <p className="dialog-copy">
          {editing
            ? "Refresh the details in your personal orbit."
            : "Add someone to your personal orbit."}
        </p>
        <div className="form-grid">
          <Input placeholder="First name" value={value.firstName} onChange={update("firstName")} />
          <Input placeholder="Last name" value={value.lastName} onChange={update("lastName")} />
          <Input placeholder="Company" value={value.company} onChange={update("company")} />
          <Input placeholder="Role" value={value.role} onChange={update("role")} />
          <Input
            className="col-span-2"
            placeholder="Email"
            value={value.email}
            onChange={update("email")}
          />
          <Input
            className="col-span-2"
            placeholder="Phone"
            value={value.phone}
            onChange={update("phone")}
          />
        </div>
        <Button
          className="primary-button w-full mt-5"
          onClick={onSave}
          disabled={pending || !value.firstName.trim() || !value.lastName.trim()}
        >
          <Plus className="h-4 w-4" />
          {editing ? "Save changes" : "Create contact"}
        </Button>
      </div>
    </div>
  );
}

// ── ContactsTab (main export) ─────────────────────────────────────────────────

interface ContactsTabProps {
  hubspotConnected: boolean;
}

export function ContactsTab({ hubspotConnected }: ContactsTabProps) {
  const [query, setQuery] = useState("");
  const searchQuery = useDebouncedValue(query.trim());
  const [page, setPage] = useState(0);
  const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
  const [showNewContact, setShowNewContact] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactEditValues | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [timelinePage, setTimelinePage] = useState(0);

  // Reset page when search changes
  useEffect(() => setPage(0), [query]);

  const utils = trpc.useUtils();

  const contactsQuery = trpc.contacts.list.useQuery({
    query: searchQuery,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const contactQuery = trpc.contacts.get.useQuery(
    { id: selectedContactId! },
    { enabled: Boolean(selectedContactId) },
  );

  const interactionsQuery = trpc.interactions.list.useQuery(
    { contactId: selectedContactId ?? undefined, limit: PAGE_SIZE, offset: timelinePage * PAGE_SIZE },
    { enabled: Boolean(selectedContactId) },
  );

  const createContact = trpc.contacts.create.useMutation({
    onSuccess: () => {
      toast.success("Contact added");
      setShowNewContact(false);
      void utils.contacts.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
  });

  const updateContact = trpc.contacts.update.useMutation({
    onSuccess: () => {
      toast.success("Contact updated");
      setEditingContact(null);
      void utils.contacts.list.invalidate();
      void utils.contacts.get.invalidate();
    },
  });

  const deleteContact = trpc.contacts.delete.useMutation({
    onSuccess: () => {
      toast.success("Contact deleted");
      setSelectedContactId(null);
      setDeleteTarget(null);
      void utils.contacts.list.invalidate();
      void utils.dashboard.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const syncContact = trpc.integrations.syncContact.useMutation({
    onSuccess: () => {
      toast.success("Contact synced to HubSpot");
      void utils.contacts.list.invalidate();
      void utils.contacts.get.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const activeContact = contactQuery.data ?? null;

  return (
    <>
      <ContactGrid
        contacts={(contactsQuery.data as Contact[]) ?? []}
        loading={contactsQuery.isLoading}
        query={query}
        setQuery={setQuery}
        onSelect={setSelectedContactId}
        onAdd={() => setShowNewContact(true)}
      />

      <Paging
        page={page}
        setPage={setPage}
        hasNext={(contactsQuery.data?.length ?? 0) === PAGE_SIZE}
      />

      {/* Contact drawer */}
      {selectedContactId && (
        <ContactDrawer
          contact={activeContact}
          interactions={(interactionsQuery.data as Interaction[]) ?? []}
          onClose={() => setSelectedContactId(null)}
          onEdit={() =>
            activeContact &&
            setEditingContact({
              id: activeContact.id,
              firstName: activeContact.firstName,
              lastName: activeContact.lastName,
              company: activeContact.company ?? "",
              role: activeContact.role ?? "",
              email: activeContact.email ?? "",
              phone: activeContact.phone ?? "",
            })
          }
          onDelete={() => activeContact && setDeleteTarget(activeContact)}
          onSync={() => activeContact && syncContact.mutate({ id: activeContact.id })}
          syncing={syncContact.isPending}
          hubspotConnected={hubspotConnected}
          timelinePage={timelinePage}
          setTimelinePage={setTimelinePage}
        />
      )}

      {/* New contact dialog */}
      {showNewContact && (
        <NewContactWrapper
          onClose={() => setShowNewContact(false)}
          onSave={(v) => createContact.mutate(v)}
          pending={createContact.isPending}
        />
      )}

      {/* Edit contact dialog */}
      {editingContact && (
        <ContactFormDialog
          value={editingContact}
          setValue={(v) => setEditingContact(v as ContactEditValues)}
          onClose={() => setEditingContact(null)}
          onSave={() => updateContact.mutate(editingContact)}
          editing
          pending={updateContact.isPending}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.firstName} ${deleteTarget?.lastName}?`}
        description="This also permanently deletes all their notes and tasks. This action cannot be undone."
        confirmLabel="Delete contact"
        destructive
        onConfirm={() => deleteTarget && deleteContact.mutate({ id: deleteTarget.id })}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ── Stateful wrapper so new-contact form has its own controlled state ─────────

function NewContactWrapper({
  onClose,
  onSave,
  pending,
}: {
  onClose: () => void;
  onSave: (v: ContactFormValues) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState<ContactFormValues>({
    firstName: "",
    lastName: "",
    company: "",
    role: "",
    email: "",
    phone: "",
  });
  return (
    <ContactFormDialog
      value={value}
      setValue={(v) => setValue(v as ContactFormValues)}
      onClose={onClose}
      onSave={() => onSave(value)}
      pending={pending}
    />
  );
}
