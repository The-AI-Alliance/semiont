package launcher

import (
	"fmt"
	"strings"
)

const aboutUsage = `Usage: semiont about

Show what Semiont is, where it lives, and what this launcher drives:
version, project links, image registry, and the container runtimes
detected on this machine.
`

// About implements `semiont about` — the identity card behind the header.
func About(args []string) int {
	u := NewUI(false)
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Print(aboutUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", a)
			return 1
		}
	}

	fmt.Println(u.Bold("Semiont 🌐"))
	fmt.Println(u.Wrap(AnsiCyan, "The AI Alliance 🌎🌍"))
	fmt.Println()
	fmt.Println("An open, source-grounded semantic knowledge platform — a shared workspace")
	fmt.Println("where humans and AI agents annotate, connect, enrich, and govern domain")
	fmt.Println("knowledge for accurate applications, agents, and workflows.")
	fmt.Println()

	runtimes := "none found — install Apple container, Docker, or Podman"
	if found := installedRuntimes(); len(found) > 0 {
		runtimes = strings.Join(found, ", ") + " " + u.Dim("(detected on PATH)")
	}
	row := func(label, value string) {
		fmt.Printf("  %s %s\n", u.Bold(fmt.Sprintf("%-9s", label)), value)
	}
	row("Version", fmt.Sprintf("%s %s", BuildVersion, u.Dim(fmt.Sprintf("(commit %s, built %s)", BuildCommit, BuildDate))))
	row("Website", "https://the-ai-alliance.github.io/semiont/")
	row("Source", "https://github.com/The-AI-Alliance/semiont")
	row("Issues", "https://github.com/The-AI-Alliance/semiont/issues")
	row("Images", imageRegistry+" "+u.Dim("(SEMIONT_VERSION selects the tag; default latest)"))
	row("License", "Apache-2.0")
	row("Runtimes", runtimes)

	fmt.Println()
	fmt.Println(u.Dim("This launcher runs the local Semiont stack — graph (Neo4j), vectors"))
	fmt.Println(u.Dim("(Qdrant), inference (Ollama), database (PostgreSQL), traces (Jaeger), and the"))
	fmt.Println(u.Dim("Semiont gateway, worker, smelter, weaver, and Browser — by driving your"))
	fmt.Println(u.Dim("container runtime directly. Try: semiont start --help"))
	fmt.Println()
	fmt.Println(u.Wrap(AnsiMagenta, "✨ Make Meaning"))
	return 0
}
