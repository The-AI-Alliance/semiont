package stack

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixtureCopy: the launcher's fixture knowledge base, copied to a directory
// the test may change.
func fixtureCopy(t *testing.T) string {
	t.Helper()
	from := filepath.Join(repository, "packages", "go", "launcher", "testdata", "kb")
	root := t.TempDir()
	err := filepath.WalkDir(filepath.Join(from, Dir), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(root, rel), 0o755)
		}
		text, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(root, rel), text, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// edit replaces old, which must be in the document, with new.
func edit(t *testing.T, root, file, old, new string) {
	t.Helper()
	path := filepath.Join(root, file)
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), old) {
		t.Fatalf("%s does not say %q", file, old)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(text), old, new, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The fixture knowledge base loads whole: each document, and the Inference
// document asked for.
func TestLoadReadsEveryDocument(t *testing.T) {
	st, err := Load(fixtureCopy(t), "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if st.Inference.Metadata.Name != "anthropic" || st.Files.Inference != filepath.Join(Dir, InferenceDir, "anthropic.yaml") {
		t.Errorf("the Inference document read is %q, from %s", st.Inference.Metadata.Name, st.Files.Inference)
	}
}

// A knowledge base without a document it needs is refused, naming the file.
func TestLoadRefusesADocumentThatIsNotThere(t *testing.T) {
	for _, missing := range []string{KnowledgeBaseFile, KnowledgeIndexFile} {
		t.Run(missing, func(t *testing.T) {
			root := fixtureCopy(t)
			if err := os.Remove(filepath.Join(root, Dir, missing)); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(root, "anthropic"); !errors.Is(err, fs.ErrNotExist) || !strings.Contains(err.Error(), missing) {
				t.Errorf("a knowledge base without %s loaded, or was refused without naming it: %v", missing, err)
			}
		})
	}
	if _, err := Load(fixtureCopy(t), "absent"); !errors.Is(err, fs.ErrNotExist) || !strings.Contains(err.Error(), "absent.yaml") {
		t.Errorf("an Inference document that is not there was not refused by name: %v", err)
	}
}

// Each name one document gives another must name the document there.
func TestLoadRefusesANameThatDoesNotHold(t *testing.T) {
	for _, c := range []struct {
		why, file, old, new, refusal string
	}{
		{"the index names another knowledge base", KnowledgeIndexFile, "knowledgeBase: knowledge-base", "knowledgeBase: elsewhere", "index.yaml: spec.knowledgeBase names \"elsewhere\""},
		{"the Inference document is named otherwise than its file", filepath.Join(InferenceDir, "anthropic.yaml"), "name: anthropic", "name: elsewhere", "an Inference document is named by its file"},
	} {
		t.Run(c.why, func(t *testing.T) {
			root := fixtureCopy(t)
			edit(t, root, filepath.Join(Dir, c.file), c.old, c.new)
			if _, err := Load(root, "anthropic"); err == nil || !strings.Contains(err.Error(), c.refusal) {
				t.Errorf("loaded, or refused other than with %q: %v", c.refusal, err)
			}
		})
	}
}

// The issuer the launcher runs is the machine's: a knowledge base holding an
// Issuer document of its own, whichever issuer it names, is refused by the
// file's name, and told where the machine keeps one.
func TestLoadRefusesAnIssuerDocumentOfItsOwn(t *testing.T) {
	issuer, err := os.ReadFile(filepath.Join(repository, "packages", "go", "launcher", "testdata", IssuerFile))
	if err != nil {
		t.Fatal(err)
	}
	for _, names := range []string{"shared: { accessTokenLifespan: 300 }", "external: { type: oidc, url: https://issuer.example.org }"} {
		t.Run(names, func(t *testing.T) {
			root := fixtureCopy(t)
			edit(t, root, filepath.Join(Dir, KnowledgeBaseFile), "shared:\n      accessTokenLifespan: 300", names)
			if err := os.WriteFile(filepath.Join(root, Dir, IssuerFile), issuer, 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := Load(root, "anthropic")
			if err == nil || !strings.HasPrefix(err.Error(), filepath.Join(Dir, IssuerFile)+":") || !strings.Contains(err.Error(), filepath.Join(StateHomeDir, IssuerFile)) {
				t.Errorf("a knowledge base holding %s loaded, or was refused without naming it and the state home's: %v", IssuerFile, err)
			}
		})
	}
}

// The Inference documents a knowledge base holds, by name and in order.
func TestInferenceNamesListsTheDocuments(t *testing.T) {
	if got, want := InferenceNames(fixtureCopy(t)), []string{"anthropic", "ollama-gemma"}; !reflect.DeepEqual(got, want) {
		t.Errorf("InferenceNames = %v, want %v", got, want)
	}
	if got := InferenceNames(t.TempDir()); len(got) != 0 {
		t.Errorf("a directory with no Inference documents names %v", got)
	}
}

// What Marshal writes reads back as the document it was given, and states the
// apiVersion every document of the fixture states.
func TestMarshalWritesADocumentThatReadsBack(t *testing.T) {
	st, err := Load(fixtureCopy(t), "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if st.KnowledgeBase.ApiVersion != APIVersion {
		t.Errorf("the fixture states apiVersion %q, and APIVersion is %q", st.KnowledgeBase.ApiVersion, APIVersion)
	}
	issuer, err := Read[Issuer](filepath.Join(repository, "packages", "go", "launcher", "testdata", IssuerFile), "Issuer")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		kind     string
		document any
		read     func([]byte) (any, error)
	}{
		{"KnowledgeBase", st.KnowledgeBase, func(text []byte) (any, error) { return Parse[KnowledgeBase]("kb", "KnowledgeBase", text) }},
		{"KnowledgeIndex", st.KnowledgeIndex, func(text []byte) (any, error) { return Parse[KnowledgeIndex]("index", "KnowledgeIndex", text) }},
		{"Issuer", issuer, func(text []byte) (any, error) { return Parse[Issuer]("issuer", "Issuer", text) }},
		{"Inference", st.Inference, func(text []byte) (any, error) { return Parse[Inference]("inference", "Inference", text) }},
	} {
		t.Run(c.kind, func(t *testing.T) {
			text, err := Marshal(c.document)
			if err != nil {
				t.Fatal(err)
			}
			back, err := c.read(text)
			if err != nil {
				t.Fatalf("what Marshal wrote is refused: %v\n%s", err, text)
			}
			if !reflect.DeepEqual(back, c.document) {
				t.Errorf("what Marshal wrote reads back otherwise:\n%s", text)
			}
		})
	}
}

// SetScalar changes the one value it names: the document reads back with that
// field changed and every other the same, and a person's comments stay where
// they wrote them. A field the document does not have, or one that is not a
// single value, is refused.
func TestSetScalarChangesOneFieldAndKeepsComments(t *testing.T) {
	path := filepath.Join(repository, "packages", "go", "launcher", "testdata", IssuerFile)
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text = append([]byte("# the issuer for this laptop\n"), text...)
	text = []byte(strings.Replace(string(text), "  port: 8080\n", "  port: 8080 # where my browser expects it\n", 1))
	before, err := Parse[Issuer]("issuer", "Issuer", text)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := SetScalar(text, []string{"spec", "port"}, "8081")
	if err != nil {
		t.Fatal(err)
	}
	after, err := Parse[Issuer]("issuer", "Issuer", changed)
	if err != nil {
		t.Fatalf("what SetScalar wrote is refused: %v\n%s", err, changed)
	}
	if after.Spec.Port != 8081 {
		t.Errorf("spec.port reads back as %d:\n%s", after.Spec.Port, changed)
	}
	after.Spec.Port = before.Spec.Port
	if !reflect.DeepEqual(after, before) {
		t.Errorf("SetScalar changed more than spec.port:\n%s", changed)
	}
	for _, comment := range []string{"# the issuer for this laptop\n", "port: 8081 # where my browser expects it\n"} {
		if !strings.Contains(string(changed), comment) {
			t.Errorf("SetScalar lost %q:\n%s", comment, changed)
		}
	}
	for _, location := range [][]string{{"spec", "proxy"}, {"spec", "database"}, {"spec", "port", "number"}} {
		if _, err := SetScalar(text, location, "1"); err == nil {
			t.Errorf("SetScalar of %v is not refused", location)
		}
	}
}
