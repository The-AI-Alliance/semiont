# Working in the Browser

What an analyst does in the Semiont Browser, in the order the work usually goes: find or add a resource, read it, annotate it, link it, and generate from it. Names in **bold** are the labels on screen.

A **resource** is anything a knowledge base holds: a document, an image, a PDF, any file. To get the Browser and sign in, see [README.md](README.md).

## Find a resource

- **Discover** lists the knowledge base's resources. Search by name or content. When no title matches, it shows related documents instead. Filter by entity type. Archived resources are marked.
- **Global search** opens from anywhere with `Cmd/Ctrl + K` or `/`, and searches resources and entities.
- Resources you open stay as tabs in the sidebar. Drag a tab to reorder it.

## Add a resource

**Compose** creates one. Give it a name, optional entity type tags and a language, then either:

- **Upload File**: drop a file or click to choose one. The media type is detected from the file.
- **Write Content**: type or paste text, and pick its format.

Any file type can be uploaded. What you can do with it afterwards depends on the type:

| Type | In the Browser |
|---|---|
| Markdown, plain text, HTML, JSON | Read it, and annotate passages of text |
| PNG, JPEG | View it, and annotate regions |
| PDF | Read it page by page, and annotate regions. Its text is analyzed once its text layer is ready |
| Anything else | Catalogued for download |

A PDF's **Resource Info** shows its **Text layer**: Ready, Preparing, or None when it has no extractable text.

## Read and annotate

The toolbar's **Mode** switches between **Browse** and **Annotate**. Annotate is where the work happens:

1. Pick a **Motivation**.
2. Select text. On an image or a PDF, draw a **Shape** instead: **Rectangle**, **Circle** or **Polygon**.
3. The **Annotations** panel opens on that motivation. A highlight is created at once; the others ask for what they need first.

| Motivation | What it records |
|---|---|
| **Highlight** | This passage matters |
| **Comment** | A note on the passage |
| **Assess** | A judgement of the passage |
| **Tag** | A category from one of the knowledge base's tag schemas |
| **Reference** | The passage refers to something. Entity types are optional |

The toolbar's **Click** setting decides what clicking an existing annotation does:

- **Detail** opens it in the Annotations panel.
- **Follow** goes to the resource a resolved reference points at.
- **JSON-LD** shows the annotation as W3C Web Annotation JSON-LD.
- **Delete** removes it, after asking. It is offered in Annotate mode only.

## Let an agent annotate, then review

Each motivation's panel can hand a pass over the whole resource to the knowledge base's AI: **Annotate Highlights**, **Annotate Comments**, **Annotate Assessments**, **Annotate Tags**, **Annotate References**.

| Pass | What you can set |
|---|---|
| Highlights | **Instructions** and **Density** (annotations per 2,000 words) |
| Comments | Instructions, Density and **Tone**: Scholarly, Explanatory, Conversational, Technical |
| Assessments | Instructions, Density and Tone: Analytical, Critical, Balanced, Constructive |
| Tags | A **Framework** (a tag schema) and its categories. The knowledge base needs at least one schema registered |
| References | The entity types to look for, and **Include descriptive references** to also catch phrases such as "the CEO" |

Progress shows while the pass runs, and it can be cancelled. What it creates are ordinary annotations, the same as yours: read them in the panel, and delete the ones you do not want.

## References

A reference starts as a **stub**: the passage is marked, but nothing is linked. **Resolve Reference** opens the reference wizard, which gathers context around the passage and shows it: the surrounding text, the annotations beside it, what cites the resource, its **Neighborhood** in the graph, and **Similar passages** elsewhere. A **Hint** from you steers the next step. Then choose how to resolve it:

- **Search** for an existing resource and **Link** it. **Semantic Scoring** has the AI rank the results by relevance.
- **Generate** a new resource from the gathered context: set its title, instructions, language, creativity, length, format and save location.
- **Compose** it yourself, then **Create & Link**.

A resolved reference can be opened, unlinked, converted to a highlight, or deleted. The **References** panel lists a resource's **Outgoing References** and its **Incoming References**, which are the passages elsewhere that point at it.

## Generate a resource from this one

**Resource Info** has **Generate**, which writes a new resource from this one's context:

1. Choose what to gather: the resource's content, its summary, how many links deep to follow, and how many resources to take.
2. **Gather**, and read what came back. Deselect an entity type to leave it out.
3. Set the new resource's title, instructions, language, creativity, length, format and save location, then **Generate**.

The new resource records that it was derived from this one.

## The panels

The toolbar opens one panel at a time:

- **Annotations**: one tab per motivation, and **Statistics** with the counts, stub and resolved references, and entity types.
- **History**: every event on the resource, who did it and when.
- **Resource Info**: locale, entity type tags, media type, size, storage, provenance, and the **Clone**, **Generate** and **Archive** actions.
- **Collaboration**: whether the live connection is up, and recent activity.
- **User Account**: who you are signed in as, when the session expires, and **Sign Out**.
- **Settings**: theme (Light, Dark or System), line numbers, language, hover delay, and the keyboard shortcuts.
- **Knowledge Base**: the knowledge bases you are connected to.

## Archive and clone

**Archive** moves a resource out of the active list without deleting it, and **Unarchive** restores it. **Clone** makes a shareable link from which someone can create their own copy. Both are described in [ARCHIVE-CLONE.md](../../apps/browser/docs/ARCHIVE-CLONE.md).

## Moderation

The **Moderation** section has three pages: **Recent Resources**, **Entity Tags** for adding the tags resources are classified by, and **Tag Schemas** for viewing the frameworks the Tag pass uses.

## See also

- [KEYBOARD-NAV.md](KEYBOARD-NAV.md): the keyboard shortcuts
- [ACCESSIBILITY.md](ACCESSIBILITY.md): what the Browser provides for assistive technology
- [docs/builder](../builder/README.md): doing the same work from code, or from the `semiont` launcher
- [apps/browser/docs](../../apps/browser/docs/): how the Browser is built
