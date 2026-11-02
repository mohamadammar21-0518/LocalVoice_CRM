import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ContactFormValues, ContactEditValues } from "@/types";

interface ContactFormDialogProps {
  value: ContactFormValues | ContactEditValues;
  setValue: (v: ContactFormValues | ContactEditValues) => void;
  onClose: () => void;
  onSave: () => void;
  editing?: boolean;
  pending?: boolean;
}

export function ContactFormDialog({ value, setValue, onClose, onSave, editing = false, pending = false }: ContactFormDialogProps) {
  const update = (key: keyof ContactFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValue({ ...value, [key]: e.target.value });

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="new-contact-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="drawer-close" onClick={onClose}><X className="h-4 w-4" /></button>
        <p className="eyebrow">{editing ? "Edit contact" : "New contact"}</p>
        <h2>{editing ? "Keep it current." : "Make a little room."}</h2>
        <p className="dialog-copy">{editing ? "Refresh the details in your personal orbit." : "Add someone to your personal orbit."}</p>
        <div className="form-grid">
          <Input placeholder="First name" value={value.firstName} onChange={update("firstName")} />
          <Input placeholder="Last name" value={value.lastName} onChange={update("lastName")} />
          <Input placeholder="Company" value={value.company} onChange={update("company")} />
          <Input placeholder="Role" value={value.role} onChange={update("role")} />
          <Input className="col-span-2" placeholder="Email" value={value.email} onChange={update("email")} />
          <Input className="col-span-2" placeholder="Phone" value={value.phone} onChange={update("phone")} />
        </div>
        <Button className="primary-button w-full mt-5" onClick={onSave} disabled={pending || !value.firstName.trim() || !value.lastName.trim()}>
          <Plus className="h-4 w-4" />{editing ? "Save changes" : "Create contact"}
        </Button>
      </div>
    </div>
  );
}
