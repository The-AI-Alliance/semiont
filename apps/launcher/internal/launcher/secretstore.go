package launcher

// secretstore.go — the secret-store setting (`semiont settings secret-store`):
// which store keeps a knowledge base's custody values, and moving them
// between stores. One setting per KB root — a team KB can keep its secrets in
// a team vault while a personal one stays on files — keyed like the values it
// governs.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// storeSettingsPath: where each root's store setting is kept. Its own file,
// not roots.json: that registry is read leniently and rewritten best-effort
// early in every start, so a setting kept there could be read as absent —
// and absent means the filesystem, which mints new values over the ones the
// configured store keeps. This file is read strictly and written only here.
func storeSettingsPath() string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "secretstores.json")
}

// storeSettingsFile: secretstores.json. Roots maps a state key to the store
// that keeps that root's values; a root with no entry keeps them in files.
// Default, when set, is the store a new knowledge base adopts at its first
// need.
type storeSettingsFile struct {
	Default *secretRef           `json:"default,omitempty"`
	Roots   map[string]secretRef `json:"roots"`
}

// storeSettings reads secretstores.json strictly: an unknown field, or a
// store the launcher does not know, fails rather than reading as "no setting".
func storeSettings() (storeSettingsFile, error) {
	settings := storeSettingsFile{Roots: map[string]secretRef{}}
	p := storeSettingsPath()
	if p == "" {
		return settings, nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return settings, nil
	}
	if err == nil {
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		err = dec.Decode(&settings)
	}
	known := func(ref secretRef) bool { return ref.Provider == "op" && ref.Path != "" }
	if err == nil && settings.Default != nil && !known(*settings.Default) {
		err = errors.New("the default names no store the launcher knows")
	}
	for key, ref := range settings.Roots {
		if err == nil && !known(ref) {
			err = fmt.Errorf("%s names no store the launcher knows", key)
		}
	}
	if err != nil {
		return storeSettingsFile{}, fmt.Errorf("%s is unreadable (%v), so which store keeps this knowledge base's secrets is unknown. Repair or remove it; the launcher never guesses a store", p, err)
	}
	if settings.Roots == nil {
		settings.Roots = map[string]secretRef{}
	}
	return settings, nil
}

// storeSettingFor: the store configured for one root, and false for the
// filesystem default.
func storeSettingFor(key string) (secretRef, bool, error) {
	settings, err := storeSettings()
	if err != nil {
		return secretRef{}, false, err
	}
	ref, ok := settings.Roots[key]
	return ref, ok, nil
}

// defaultStoreSetting: the store a new knowledge base adopts, and false when
// new knowledge bases keep their values in files.
func defaultStoreSetting() (secretRef, bool, error) {
	settings, err := storeSettings()
	if err != nil || settings.Default == nil {
		return secretRef{}, false, err
	}
	return *settings.Default, true, nil
}

// saveStoreSetting records one root's store; configured false records the
// filesystem default by removing the entry. Never best-effort: a setting that
// did not save is a store the next start does not use.
func saveStoreSetting(key string, ref secretRef, configured bool) error {
	return changeStoreSettings(func(settings *storeSettingsFile) {
		if configured {
			settings.Roots[key] = ref
		} else {
			delete(settings.Roots, key)
		}
	})
}

// saveDefaultStoreSetting records the store new knowledge bases adopt;
// configured false returns them to files.
func saveDefaultStoreSetting(ref secretRef, configured bool) error {
	return changeStoreSettings(func(settings *storeSettingsFile) {
		settings.Default = nil
		if configured {
			settings.Default = &ref
		}
	})
}

func changeStoreSettings(change func(*storeSettingsFile)) error {
	settings, err := storeSettings()
	if err != nil {
		return err
	}
	change(&settings)
	p := storeSettingsPath()
	if p == "" {
		return errors.New("no home directory resolvable, so the setting has nowhere to be kept")
	}
	b, _ := json.MarshalIndent(settings, "", "  ")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// parseStoreTarget: `file` is the filesystem; `op://<vault>` a 1Password
// vault that holds the launcher's items and nothing else.
func parseStoreTarget(arg string) (secretRef, bool, error) {
	if arg == "file" {
		return secretRef{}, false, nil
	}
	vault, ok := strings.CutPrefix(arg, "op://")
	if !ok || vault == "" || strings.Contains(vault, "/") {
		return secretRef{}, false, fmt.Errorf("a store is `file` or op://<vault>, not %q", arg)
	}
	return secretRef{Provider: "op", Path: vault}, true, nil
}

// setSecretStore: the secret-store setting's setter. Naming a different store
// moves every kept value into it (moveSecretStore).
func setSecretStore(u *UI, root, value string) bool {
	ref, configured, err := parseStoreTarget(value)
	if err != nil {
		u.Fail("%v", err)
		return false
	}
	key := rootKey(root)
	from, ok := configuredCustody(u, key)
	if !ok {
		return false
	}
	to, ok := custodyStoreAt(u, key, ref, configured)
	if !ok {
		return false
	}
	if to.describe() == from.describe() {
		return true
	}
	return moveSecretStore(u, key, from, to, ref, configured) == 0
}

// unsetSecretStore returns a root to the default store, moving its values
// back to the files.
func unsetSecretStore(u *UI, root string) bool { return setSecretStore(u, root, "file") }

// setDefaultSecretStore: the store new knowledge bases adopt. It moves no
// knowledge base's values: the default applies to new KBs only.
func setDefaultSecretStore(u *UI, root, value string) bool {
	ref, configured, err := parseStoreTarget(value)
	if err != nil {
		u.Fail("%v", err)
		return false
	}
	if p := secretProviders[ref.Provider]; configured && !onPath(p.bin) {
		u.Fail("'%s' (%s CLI) is not on PATH, so no knowledge base could adopt %s.", p.bin, p.display, value)
		return false
	}
	return recorded(u, saveDefaultStoreSetting(ref, configured))
}

func unsetDefaultSecretStore(u *UI, root string) bool {
	return recorded(u, saveDefaultStoreSetting(secretRef{}, false))
}

// showSecretStoreLocations: where each value is kept once generated, from the
// setting alone — what a person or a skill needs to read one, with no store
// contacted.
func showSecretStoreLocations(u *UI, root string) {
	key := rootKey(root)
	ref, configured, err := storeSettingFor(key)
	if err != nil {
		return
	}
	s := custodyStoreNamed(key, ref, configured)
	fmt.Printf("  %s\n", u.Dim("each value, once a start generates it:"))
	for _, name := range custodyNames() {
		fmt.Printf("    %-34s %s\n", name, s.where(name))
	}
}

// moveSecretStore moves every kept value: copy, read each back, record the
// destination store, then delete from the source. A failure before the record
// leaves the source in charge and says what the destination holds.
func moveSecretStore(u *UI, key string, from, to custodyStore, ref secretRef, configured bool) int {
	if held, ok := to.names(u); !ok {
		return 1
	} else if len(held) > 0 {
		u.Fail("%s already holds this knowledge base's %s.", to.describe(), strings.Join(held, ", "))
		fmt.Fprintln(os.Stderr, "  Moving would leave two copies to disagree after the next rotation. Delete them there first, or keep the store you have.")
		return 1
	}
	names, ok := from.names(u)
	if !ok {
		return 1
	}
	values := map[string]string{}
	for _, name := range names {
		v, ok := from.get(u, name)
		if !ok {
			return 1
		}
		values[name] = v
	}
	abandon := func() int {
		fmt.Fprintf(os.Stderr, "  Nothing was recorded: %s still keeps these secrets. Delete what the move wrote to %s before trying again.\n", from.describe(), to.describe())
		return 1
	}
	for _, name := range names {
		if !to.put(u, name, values[name]) {
			return abandon()
		}
	}
	for _, name := range names {
		got, ok := to.get(u, name)
		if !ok {
			return abandon()
		}
		if got != values[name] {
			u.Fail("%s did not read back as written.", name)
			return abandon()
		}
	}
	if err := saveStoreSetting(key, ref, configured); err != nil {
		u.Fail("Recording the store: %v", err)
		return abandon()
	}
	delete(openCustody, key)
	for _, name := range names {
		if !from.remove(u, name) {
			u.Warn("%s now keeps this knowledge base's secrets; delete what is left in %s by hand.", to.describe(), from.describe())
			return 1
		}
	}
	u.Ok("This knowledge base now keeps its secrets in %s (%d moved).", to.describe(), len(names))
	return 0
}
