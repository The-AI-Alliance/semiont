package launcher

// secretstore.go — `semiont secret store`: which store keeps a knowledge
// base's custody values, and moving them between stores (SECRETS-STORE P3,
// P4). One setting per KB root (D1), keyed like the values it governs.

import (
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

// storeSettings: state key → the store that keeps that root's values. A root
// with no entry keeps them on the filesystem.
func storeSettings() (map[string]secretRef, error) {
	settings := map[string]secretRef{}
	p := storeSettingsPath()
	if p == "" {
		return settings, nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return settings, nil
	}
	if err == nil {
		err = json.Unmarshal(b, &settings)
	}
	if err == nil {
		for key, ref := range settings {
			if ref.Provider != "op" || ref.Path == "" {
				err = fmt.Errorf("%s names no store the launcher knows", key)
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("%s is unreadable (%v), so which store keeps this knowledge base's secrets is unknown. Repair or remove it; the launcher never guesses a store", p, err)
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
	ref, ok := settings[key]
	return ref, ok, nil
}

// saveStoreSetting records one root's store; configured false records the
// filesystem default by removing the entry. Never best-effort: a setting that
// did not save is a store the next start does not use.
func saveStoreSetting(key string, ref secretRef, configured bool) error {
	settings, err := storeSettings()
	if err != nil {
		return err
	}
	if configured {
		settings[key] = ref
	} else {
		delete(settings, key)
	}
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
// vault that holds the launcher's items and nothing else (D6).
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

const secretStoreUsage = `Usage: semiont secret store [file | op://<vault>] [--root <path|name>]

Where this knowledge base keeps the values the launcher generates for it: the
token-signing key, Keycloak's admin password, each service account's secret,
and the passwords of the daemons it runs.

With no store named, shows the store and where each kept value is.

Naming a store moves every kept value into it, reads each one back, records
the store, then deletes the values from the one it leaves. A store that
already holds values for this knowledge base is refused.

Stores:
  file            One file per value under this root's state dir (the default)
  op://<vault>    One 1Password item per knowledge base, in a vault that
                  holds the launcher's items and nothing else

Every read, write and delete is shown as it runs: the secret's name, never
its value.
`

// secretStoreCmd implements `semiont secret store`.
func secretStoreCmd(u *UI, args []string) int {
	target, rootArg := "", ""
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--help" || args[i] == "-h":
			fmt.Print(secretStoreUsage)
			return 0
		case args[i] == "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootArg = args[i+1]
			i++
		case target == "" && !strings.HasPrefix(args[i], "-"):
			target = args[i]
		default:
			u.Fail("Unknown argument: %s", args[i])
			fmt.Print(secretStoreUsage)
			return 1
		}
	}
	var root string
	var err error
	if rootArg == "" {
		root, _, err = resolveKBRoot()
	} else {
		root, err = resolveRootArg(rootArg)
	}
	if err != nil {
		u.Fail("%v", err)
		fmt.Fprintln(os.Stderr, "  Run inside a KB, or name one: semiont secret store --root <path|name>")
		return 1
	}
	key := rootKey(root)
	from, ok := custodyFor(u, root)
	if !ok {
		return 1
	}
	if target == "" {
		return showSecretStore(u, from)
	}
	ref, configured, err := parseStoreTarget(target)
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	to, ok := custodyStoreAt(u, key, ref, configured)
	if !ok {
		return 1
	}
	if to.describe() == from.describe() {
		u.Ok("This knowledge base already keeps its secrets in %s.", to.describe())
		return 0
	}
	return moveSecretStore(u, key, from, to, ref, configured)
}

func showSecretStore(u *UI, s custodyStore) int {
	names, ok := s.names(u)
	if !ok {
		return 1
	}
	fmt.Printf("This knowledge base keeps its secrets in %s.\n", s.describe())
	if len(names) == 0 {
		fmt.Println(u.Dim("  (none kept yet; the next start generates them)"))
	}
	for _, name := range names {
		fmt.Printf("  %-34s %s\n", name, s.where(name))
	}
	return 0
}

// moveSecretStore moves every kept value, as D4 rules: copy, read each back,
// record the new store, then delete from the old. A failure before the record
// leaves the old store in charge and says what the new one now holds.
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
