import { useState } from "react";
import { Building2, FileText, Layers, Plug, Search, ArrowRight } from "lucide-react";
import { twentyCatalog } from "@shared/twentyCatalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function TwentyGallery({ onUseRealEstate }: { onUseRealEstate: () => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string>();
  const apps = twentyCatalog.filter(app => (filter === "all" || app.category === filter) && app.name.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="studio-stack" aria-label="Twenty visual library">
    <div className="studio-library-heading"><div><p className="eyebrow">Built with Twenty</p><h3>Explore the visual library</h3><p>17 official source packages. Open a card for setup options.</p></div><Input aria-label="Search Twenty applications" placeholder="Search Twenty apps…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <div className="studio-row" aria-label="Filter Twenty applications">{[["all", "All apps"], ["internal", "CRM example"], ["examples", "Developer examples"], ["public", "Integrations"]].map(([key, label]) => <Button key={key} variant={filter === key ? "default" : "outline"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</div>
    <small>Illustrated previews, not screenshots or live Twenty interfaces. Only the labeled local adaptation can be created directly here.</small>
    <div className="studio-grid">{apps.map((app, index) => {
      const realEstate = app.id === "real-estate";
      const Icon = realEstate ? Building2 : app.category === "public" ? Plug : app.id === "document-generator" ? FileText : Layers;
      return <article className="studio-card twenty-gallery-card" key={app.id} style={{ '--card-index': index } as React.CSSProperties}>
        <button className={`twenty-preview twenty-preview-${app.category}`} aria-label={`Preview ${app.name}`} aria-expanded={selected === app.id} onClick={() => setSelected(selected === app.id ? undefined : app.id)}>
          <div className="twenty-preview-top"><span /><span /><span /></div>
          {realEstate ? <div className="twenty-mini-board">{["Active", "Under offer", "Sold"].map(stage => <div key={stage}><small>{stage}</small><div><Building2 size={20} /><span className="twenty-skeleton" /><span className="twenty-skeleton short" /></div></div>)}</div> : app.category === "public" ? <div className="twenty-mini-flow"><span><Icon size={28} /><small>{app.name}</small></span><ArrowRight size={22} /><span><Layers size={28} /><small>Twenty</small></span></div> : <div className="twenty-mini-document"><Icon size={25} /><span className="twenty-skeleton" /><span className="twenty-skeleton" /><span className="twenty-skeleton short" /></div>}
        </button>
        <span className="studio-pill">{realEstate ? "Local adaptation available" : app.category === "public" ? "Separate setup required" : "Developer example"}</span>
        <h3>{app.name}</h3>
        <Button variant="outline" aria-expanded={selected === app.id} onClick={() => setSelected(selected === app.id ? undefined : app.id)}>{selected === app.id ? "Close details" : "View details"}</Button>
        {selected === app.id && <div className="studio-stack twenty-gallery-details">
          <p>{realEstate ? "Create a local CRM for properties and showings. Customize the fields before saving. This adaptation excludes photos, custom views and automations; the board above is an illustration." : app.category === "public" ? "This official Twenty application runs inside Twenty. Review its setup requirements and permissions before installing. It is not installed in LocalVoice." : "An official source example for building Twenty applications. It requires the Twenty development tools; it is not a ready-to-run LocalVoice template."}</p>
          {realEstate && <Button onClick={onUseRealEstate}>Customize this CRM</Button>}
          <a className="studio-resource-link" href={app.url} target="_blank" rel="noreferrer">Official source & setup ↗</a>
        </div>}
      </article>;
    })}</div>
    {!apps.length && <div className="empty-state studio-card" role="status"><div className="empty-icon"><Search className="h-4 w-4" /></div><p>No apps match these filters.</p><Button variant="outline" onClick={() => { setSearch(""); setFilter("all"); }}>Reset filters</Button></div>}
  </section>;
}
