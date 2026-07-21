package launcher

// billing.go — `semiont status --billing`, Tier 2 of CODESPACE-COSTS.md:
// ACTUAL money, from GitHub's own usage report, opt-in behind the `user`
// scope. Everything shown is GitHub's number — quantities, rates, discounts,
// net — never a launcher estimate; the included-quota story is theirs too
// (it arrives as discountAmount). Attribution is per REPOSITORY (bare name,
// no owner — the payload's shape, verified 2026-07-20), never per codespace.

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

type usageItem struct {
	Date           string  `json:"date"` // month bucket, RFC3339
	Product        string  `json:"product"`
	SKU            string  `json:"sku"`
	Quantity       float64 `json:"quantity"`
	UnitType       string  `json:"unitType"`
	GrossAmount    float64 `json:"grossAmount"`
	DiscountAmount float64 `json:"discountAmount"`
	NetAmount      float64 `json:"netAmount"`
	RepositoryName string  `json:"repositoryName"`
}

// statusBilling renders the report, or — without the scope — exactly the fix
// and nothing else. Exit codes: 0 shown, 1 not.
func statusBilling(u *ui) int {
	if !requireGh(u, "--billing (GitHub's usage report)") {
		return 1
	}
	// captureBoth, not capture: an unauthenticated gh explains itself on
	// stderr ("please run: gh auth login") — discarding that showed a bare
	// "cannot resolve login" with no way forward.
	login, err := captureBoth("gh", "api", "user", "--jq", ".login")
	if err != nil {
		u.fail("Cannot resolve the GitHub login — is gh authenticated?")
		if msg := strings.TrimSpace(login); msg != "" {
			for _, line := range strings.Split(msg, "\n") {
				fmt.Fprintln(os.Stderr, "    gh: "+line)
			}
		}
		fmt.Fprintln(os.Stderr, "  First-time setup:  gh auth login")
		return 1
	}
	out, err := captureBoth("gh", "api", "/users/"+strings.TrimSpace(login)+"/settings/billing/usage")
	if err != nil {
		// The one expected failure is the missing scope; per the plan, print
		// exactly the fix and nothing else.
		if strings.Contains(out, "user") && strings.Contains(out, "scope") {
			u.fail("The billing report needs the `user` scope on gh's token.")
			fmt.Fprintln(os.Stderr, "  Grant it once:  gh auth refresh -h github.com -s user")
			return 1
		}
		u.fail("Usage report failed: %s", strings.TrimSpace(out))
		return 1
	}
	var body struct {
		UsageItems []usageItem `json:"usageItems"`
	}
	if json.Unmarshal([]byte(out), &body) != nil {
		u.fail("Unexpected usage-report shape — GitHub may have changed the endpoint.")
		return 1
	}

	// Aggregate the codespaces lines per month: compute hours, storage, and
	// the three money columns. Repos noted per month (bare names — the
	// payload has no owner, and inventing one would be a guess).
	type monthAgg struct {
		computeH, storageGBh, gross, discount, net float64
		repos                                      map[string]bool
	}
	months := map[string]*monthAgg{}
	for _, it := range body.UsageItems {
		if it.Product != "codespaces" {
			continue
		}
		key := it.Date
		if len(key) >= 7 {
			key = key[:7]
		}
		m := months[key]
		if m == nil {
			m = &monthAgg{repos: map[string]bool{}}
			months[key] = m
		}
		switch {
		case strings.HasPrefix(it.SKU, "Codespaces compute"):
			m.computeH += it.Quantity
		case it.SKU == "Codespaces storage":
			m.storageGBh += it.Quantity
		}
		m.gross += it.GrossAmount
		m.discount += it.DiscountAmount
		m.net += it.NetAmount
		if it.RepositoryName != "" {
			m.repos[it.RepositoryName] = true
		}
	}

	u.section("CODESPACES BILLING")
	if len(months) == 0 {
		fmt.Printf("  %s\n", u.dim("(no codespaces usage in GitHub's report)"))
		return 0
	}
	fmt.Printf("  %s\n", u.dim("GitHub's own usage report (gh api /users/"+strings.TrimSpace(login)+"/settings/billing/usage) — monthly buckets;"))
	fmt.Printf("  %s\n", u.dim("\"included\" is plan quota GitHub applied as a discount. NET is what you pay."))
	fmt.Println()
	keys := make([]string, 0, len(months))
	for k := range months {
		keys = append(keys, k)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	for _, k := range keys {
		m := months[k]
		repos := make([]string, 0, len(m.repos))
		for r := range m.repos {
			repos = append(repos, r)
		}
		sort.Strings(repos)
		net := fmt.Sprintf("net $%.2f", m.net)
		if m.net > 0 {
			net = u.bold(net) // the months that actually cost money must pop
		}
		fmt.Printf("  %s  %5.1f compute-hrs · %5.1f GB-hrs storage   gross $%6.2f   included $%6.2f   %s  %s\n",
			k, m.computeH, m.storageGBh, m.gross, m.discount, net, u.dim("("+strings.Join(repos, ", ")+")"))
	}
	return 0
}
