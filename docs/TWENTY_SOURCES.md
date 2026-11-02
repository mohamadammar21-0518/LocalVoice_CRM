# Twenty source catalog

Snapshot: `7a61a2ad9a8d74545b6d04a81f533c56046b705e` of https://github.com/twentyhq/twenty.

The catalog includes all 17 application packages found under `packages/twenty-apps/examples`, `public`, and `internal` at this revision; test fixtures are excluded. It is not a claim to include every template or feature in Twenty. Catalog entries link to original source, not installed integrations.

The Real Estate local blueprint adapts `internal/real-estate/src/objects/property.object.ts` and `showing.object.ts`. The upstream package declares MIT. Properties retain status/type choices and numeric fields; showings retain status and rating choices. LocalVoice uses plain text for address, scheduled time and feedback, and a number for price. Photos, defaults, standard-object relationships, layouts, views, functions and workflows are not imported. LocalVoice adds required names. The full upstream app runs in Twenty, not the LocalVoice renderer.

## MIT attribution for adapted application schema

Copyright (c) 2023-present Twenty.com, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
