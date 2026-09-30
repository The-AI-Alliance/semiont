package launcher

// custodystore_op.go — the 1Password custody store (SECRETS-STORE P2).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// opBackend: one 1Password Secure Note per KB root, in the vault the root's
// store names, with one concealed field per custody name (SECRETS-STORE D2,
// D6). The commands are the ones SECRETS-STORE's P0 probe ran against the
// real CLI. Every value travels on stdin, never on the command line.
//
// The item is read once and kept in memory, so a start costs one list and one
// `item get` (0.6s), where twelve `op read`s took ~7s. A write re-reads it
// rather than trusting what the CLI printed back.
type opBackend struct {
	vault, title string
	loaded       bool
	item         map[string]any // as `op item get --format json --reveal` printed it; nil when there is none
}

// opItemTitle: the title of a root's item. A person or a skill reads a value
// at op://<vault>/<title>/<name>.
func opItemTitle(key string) string { return "Semiont — " + key }

func (o *opBackend) where(name string) string {
	return "op://" + o.vault + "/" + o.title + "/" + name
}

func (o *opBackend) describe() string {
	return fmt.Sprintf("%s vault %q, item %q", secretProviders["op"].display, o.vault, o.title)
}

// read runs one reading command of the 1Password CLI with the terminal
// attached, as resolution does, so any sign-in it asks for works.
func (o *opBackend) read(args ...string) ([]byte, bool) {
	return o.run(os.Stdin, args...)
}

// write runs one writing command with exactly stdin as its input: the values
// when there are any, and never the launcher's own stdin, which the CLI would
// take for an item template.
func (o *opBackend) write(stdin []byte, args ...string) bool {
	_, ok := o.run(bytes.NewReader(stdin), args...)
	return ok
}

// run: the CLI's own stderr — its errors, and any prompt — reaches the
// terminal.
func (o *opBackend) run(stdin io.Reader, args ...string) ([]byte, bool) {
	cmd := exec.Command(secretProviders["op"].bin, args...)
	cmd.Stdin, cmd.Stderr = stdin, os.Stderr
	out, err := cmd.Output()
	return out, err == nil
}

// unanswered reports a command 1Password refused or could not run.
func (o *opBackend) unanswered(u *UI, what string) {
	u.Fail("1Password did not answer (%s, %s).", what, o.describe())
	fmt.Fprintln(os.Stderr, "  Approve its authorization prompt, or sign in (op signin). The launcher never falls back to another store.")
}

// load reads the root's item once. Listing first tells "no item yet" (a root's
// first start) from "1Password did not answer", which a failed `item get`
// alone cannot.
func (o *opBackend) load(u *UI) bool {
	if o.loaded {
		return true
	}
	out, ok := o.read("item", "list", "--vault", o.vault, "--format", "json")
	if !ok {
		o.unanswered(u, "listing the vault")
		return false
	}
	var listed []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(out, &listed); err != nil {
		u.Fail("1Password's item list for vault %q is unreadable: %v", o.vault, err)
		return false
	}
	var ids []string
	for _, it := range listed {
		if it.Title == o.title {
			ids = append(ids, it.ID)
		}
	}
	switch len(ids) {
	case 0:
		o.item, o.loaded = nil, true
		return true
	case 1:
	default:
		u.Fail("Vault %q holds %d items titled %q; the launcher keeps one per knowledge base.", o.vault, len(ids), o.title)
		fmt.Fprintln(os.Stderr, "  Merge them into one, or delete the ones the launcher did not write.")
		return false
	}
	out, ok = o.read("item", "get", ids[0], "--vault", o.vault, "--format", "json", "--reveal")
	if !ok {
		o.unanswered(u, "reading the item")
		return false
	}
	var item map[string]any
	if err := json.Unmarshal(out, &item); err != nil {
		u.Fail("1Password's item %q is unreadable: %v", o.title, err)
		return false
	}
	if id, _ := item["id"].(string); id == "" {
		u.Fail("1Password's item %q came back with no id.", o.title)
		return false
	}
	o.item, o.loaded = item, true
	return true
}

func (o *opBackend) itemID() string {
	id, _ := o.item["id"].(string)
	return id
}

// fields: the item's fields, as the CLI printed them.
func (o *opBackend) fields() []map[string]any {
	var out []map[string]any
	list, _ := o.item["fields"].([]any)
	for _, f := range list {
		if m, ok := f.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func (o *opBackend) field(name string) map[string]any {
	for _, f := range o.fields() {
		if f["label"] == name {
			return f
		}
	}
	return nil
}

func (o *opBackend) get(u *UI, name string) (string, bool) {
	if !o.load(u) {
		return "", false
	}
	v, _ := o.field(name)["value"].(string)
	return v, true
}

func (o *opBackend) put(u *UI, name, value string) bool {
	if !o.load(u) {
		return false
	}
	concealed := map[string]any{"id": name, "label": name, "type": "CONCEALED", "value": value}
	if o.item == nil {
		body, _ := json.Marshal(map[string]any{
			"title": o.title, "category": "SECURE_NOTE", "fields": []any{concealed},
		})
		if !o.write(body, "item", "create", "--vault", o.vault, "--format", "json") {
			o.unanswered(u, "creating the item")
			return false
		}
		o.loaded = false
		return true
	}
	if f := o.field(name); f != nil {
		f["value"] = value
	} else {
		fields, _ := o.item["fields"].([]any)
		o.item["fields"] = append(fields, concealed)
	}
	body, _ := json.Marshal(o.item)
	o.loaded = false
	if !o.write(body, "item", "edit", o.itemID(), "--vault", o.vault, "--format", "json") {
		o.unanswered(u, "writing "+name)
		return false
	}
	return true
}

func (o *opBackend) remove(u *UI, name string) bool {
	if !o.load(u) {
		return false
	}
	if o.item == nil || o.field(name) == nil {
		return true
	}
	o.loaded = false
	if !o.write(nil, "item", "edit", o.itemID(), "--vault", o.vault, name+"[delete]", "--format", "json") {
		o.unanswered(u, "deleting "+name)
		return false
	}
	return true
}

func (o *opBackend) names(u *UI) ([]string, bool) {
	if !o.load(u) {
		return nil, false
	}
	var out []string
	for _, name := range custodyNames() {
		if o.field(name) != nil {
			out = append(out, name)
		}
	}
	return out, true
}
