# API Design

Think of Semiont as a Wiki.

The main concepts are:

- Documents
- When given an "entity type" tag, we can think of a Document as an entity
- Documents contain "references"
  - In the case of many kinds of documents, including raw text, we can think of a "reference" as a "text span", identified by a character offset and a length.
  - For programming languages, a reference could be a traversal of the parse tree to a specific AST node.  For nodes that contain text, this would additionally include an offset a length within that text.
  - For images, this could be a bounding square or a bounding circle or some other kind of shape
  - For audio, it would be a time offset and run length
  - Etc
- A "reference" is considered to be "resolved" if it has the id of a document.  If the document has entity type tags, then the reference is an entity reference.
- A document is created via an api call that includes the full document object, a document name, entity type(s) for the document, any any initial references, optionally resolved.  This document is saved to the filesystem (eg EFS) that the backend has access to.
- Another api endpoint triggers the detection of references within the document.  They are returned in the payload.  The initial references may also contain provisional "resolutions".
- One API endpoint would simply resolve a reference given a reference and a referent (document/entity id).  In wiki fashion, another one would create the document given a reference.  Another variant would create the document but also ask that the context of the reference be used to generate the document being created.  Another endpoint would return a fielded summary of an document suitable for a specific reference (it would take into account the context of the reference).

Later

- stop --service janusgraph

- move .env into the environments/* files
  - .env.janusgraph for JanusGraph
  - .env.neo4j for Neo4j (if provisioned)
  - .env.neptune for AWS Neptune (in production)

- neptune in data-stack.ts
- create/migrate for graph db
- get graph schema
- graph retrieval
- auto-generate document
- versioning/history for documents
- user attribution/ownership for documents
- references have semantic relationship types
- bulk operations
- validation/constraints on references
