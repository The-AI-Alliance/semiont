package launcher

// issuerdoc.go — the issuer's document: the Keycloak the launcher runs for
// every knowledge base here that names `shared`, the port it is published
// on, and the PostgreSQL it keeps their realms in. The issuer belongs to no
// knowledge base, so its document is one of the state home's
// (statehomedoc.go).

import (
	"os"
	"strconv"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// issuerDocumentPath: where the issuer's document is kept.
func issuerDocumentPath() string {
	return stateHomeDocumentPath(stack.IssuerFile)
}

// issuerDocument: the issuer's document as a command read it.
type issuerDocument struct {
	path string
	spec stack.IssuerSpec
	// fromCatalog: there was no document. This command wrote the catalog's,
	// or, in a dry run, plans with what a start would write.
	fromCatalog bool
}

// catalogIssuer: the issuer's document as the launcher writes it, from its
// catalog: Keycloak and its PostgreSQL, each on its product's port.
func catalogIssuer() stack.Issuer {
	keycloak := descriptorFor("identity", "keycloak")
	postgres := descriptorFor("identity-store", "postgres")
	dbImage, dbResources, dbPort := postgres.image, limits(postgres.mem), postgres.defaultPort
	return stack.Issuer{
		ApiVersion: stack.APIVersion,
		Kind:       "Issuer",
		Metadata:   stack.Metadata{Name: "issuer"},
		Spec: stack.IssuerSpec{
			Type:      "keycloak",
			Image:     keycloak.image,
			Resources: limits(keycloak.mem),
			Port:      keycloak.defaultPort,
			Database: stack.IssuerDatabase{
				Type: "postgres", Name: "keycloak", User: "postgres",
				Image: &dbImage, Resources: &dbResources, Port: &dbPort,
			},
		},
	}
}

// loadIssuerDocument: the issuer's document, written from the catalog first
// when there is none, unless preview (a dry run), which writes nothing.
func loadIssuerDocument(preview bool) (issuerDocument, error) {
	read, path, fromCatalog, err := loadStateHomeDocument(stack.IssuerFile, "Issuer", "the issuer's", catalogIssuer(), preview)
	return issuerDocument{path: path, spec: read.Spec, fromCatalog: fromCatalog}, err
}

// readIssuerDocument: loadIssuerDocument for a command, which says where it
// wrote one and refuses one that does not hold.
func readIssuerDocument(u *UI, preview bool) (issuerDocument, bool) {
	doc, err := loadIssuerDocument(preview)
	return doc, reportStateHomeDocument(u, "Issuer", "the image, memory, ports or database", doc.path, doc.fromCatalog, preview, err)
}

// writeIssuerPort sets the port the issuer is published on in its document,
// written first from the catalog where there is none, and keeps the rest of
// the document as it was written, comments too.
func writeIssuerPort(port int) error {
	doc, err := loadIssuerDocument(false)
	if err != nil {
		return err
	}
	text, err := os.ReadFile(doc.path)
	if err != nil {
		return err
	}
	if text, err = stack.SetScalar(text, []string{"spec", "port"}, strconv.Itoa(port)); err != nil {
		return err
	}
	_, err = writeStateHomeDocument[stack.Issuer](doc.path, "Issuer", text, false)
	return err
}

// issuerOf: the issuer's document for a knowledge base whose stack is st —
// read when it names the shared issuer, and nil when it trusts somebody
// else's, which no document of this machine's describes.
func issuerOf(u *UI, st *stack.Stack, preview bool) (*issuerDocument, bool) {
	if st.KnowledgeBase.Spec.Issuer.Shared == nil {
		return nil, true
	}
	doc, ok := readIssuerDocument(u, preview)
	return &doc, ok
}
