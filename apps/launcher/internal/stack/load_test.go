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
	from := filepath.Join(repository, "apps", "launcher", "testdata", "kb")
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

// The fixture knowledge base loads whole: each document, the Issuer its
// KnowledgeBase names, its workers, and the Inference document asked for.
func TestLoadReadsEveryDocument(t *testing.T) {
	st, err := Load(fixtureCopy(t), "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if st.Issuer == nil || st.Workers == nil {
		t.Fatalf("the Issuer and the WorkerPool were not read: %+v", st)
	}
	if st.Inference.Metadata.Name != "anthropic" || st.Files.Inference != filepath.Join(Dir, InferenceDir, "anthropic.yaml") {
		t.Errorf("the Inference document read is %q, from %s", st.Inference.Metadata.Name, st.Files.Inference)
	}
}

// A knowledge base without workers.yaml has no workers; one without any other
// document it needs is refused, naming the file.
func TestLoadReadsWorkersOnlyWhenTheyAreThere(t *testing.T) {
	root := fixtureCopy(t)
	if err := os.Remove(filepath.Join(root, Dir, WorkerPoolFile)); err != nil {
		t.Fatal(err)
	}
	st, err := Load(root, "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if st.Workers != nil {
		t.Errorf("a knowledge base without %s has workers: %+v", WorkerPoolFile, st.Workers)
	}

	for _, missing := range []string{KnowledgeBaseFile, KnowledgeIndexFile, IssuerFile} {
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

// Each name one document gives another must name the document there, and a
// knowledge base cannot both trust somebody else's issuer and describe one of
// its own.
func TestLoadRefusesANameThatDoesNotHold(t *testing.T) {
	for _, c := range []struct {
		why, file, old, new, refusal string
	}{
		{"the index names another knowledge base", KnowledgeIndexFile, "knowledgeBase: knowledge-base", "knowledgeBase: elsewhere", "index.yaml: spec.knowledgeBase names \"elsewhere\""},
		{"the workers name another knowledge base", WorkerPoolFile, "knowledgeBase: knowledge-base", "knowledgeBase: elsewhere", "workers.yaml: spec.knowledgeBase names \"elsewhere\""},
		{"the knowledge base names another issuer", KnowledgeBaseFile, "ref: issuer", "ref: elsewhere", "knowledge-base.yaml: spec.issuer.ref names \"elsewhere\""},
		{"the Inference document is named otherwise than its file", filepath.Join(InferenceDir, "anthropic.yaml"), "name: anthropic", "name: elsewhere", "an Inference document is named by its file"},
		{"an external issuer beside an Issuer document", KnowledgeBaseFile, "ref: issuer", "external: { type: oidc, url: https://issuer.example.org }", "delete one of the two"},
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

// A knowledge base that trusts somebody else's issuer, and describes none,
// loads without one.
func TestLoadReadsNoIssuerForAnExternalOne(t *testing.T) {
	root := fixtureCopy(t)
	edit(t, root, filepath.Join(Dir, KnowledgeBaseFile), "ref: issuer", "external: { type: oidc, url: https://issuer.example.org }")
	if err := os.Remove(filepath.Join(root, Dir, IssuerFile)); err != nil {
		t.Fatal(err)
	}
	st, err := Load(root, "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if st.Issuer != nil {
		t.Errorf("a knowledge base trusting an external issuer has one of its own: %+v", st.Issuer)
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
	for _, c := range []struct {
		kind     string
		document any
		read     func([]byte) (any, error)
	}{
		{"KnowledgeBase", st.KnowledgeBase, func(text []byte) (any, error) { return Parse[KnowledgeBase]("kb", "KnowledgeBase", text) }},
		{"KnowledgeIndex", st.KnowledgeIndex, func(text []byte) (any, error) { return Parse[KnowledgeIndex]("index", "KnowledgeIndex", text) }},
		{"Issuer", *st.Issuer, func(text []byte) (any, error) { return Parse[Issuer]("issuer", "Issuer", text) }},
		{"WorkerPool", *st.Workers, func(text []byte) (any, error) { return Parse[WorkerPool]("workers", "WorkerPool", text) }},
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
