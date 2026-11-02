// Inventory of official application packages, excluding test fixtures.
export const twentyRevision = "7a61a2ad9a8d74545b6d04a81f533c56046b705e";
export const twentyCatalog = [
  ["examples", "document-generator", "Document Generator"],
  ["examples", "hello-world", "Hello World"],
  ["examples", "media-notes", "Media Notes"],
  ["examples", "postcard", "Postcard"],
  ["internal", "real-estate", "Real Estate"],
  ["public", "call-recorder", "Call Recorder"],
  ["public", "companion", "Companion"],
  ["public", "discord", "Discord"],
  ["public", "exa", "Exa"],
  ["public", "fathom", "Fathom"],
  ["public", "fireflies", "Fireflies"],
  ["public", "granola", "Granola"],
  ["public", "last-contact", "Last Contact"],
  ["public", "linear", "Linear"],
  ["public", "people-data-labs", "People Data Labs"],
  ["public", "slack", "Slack"],
  ["public", "teams", "Teams"],
].map(([category, id, name]) => ({ category, id, name,
  url: `https://github.com/twentyhq/twenty/tree/${twentyRevision}/packages/twenty-apps/${category}/${id}`,
}));
