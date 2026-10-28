package verbs

// mcp_resources.go — a knowledge base's resources, as MCP resources. Each is
// named by the knowledge base's key and its id
// (semiont://kb/<key>/resources/<id>, the key escaped as a URI template
// escapes it), read through browse.resourceContent, and listed through
// browse.resources: the first page of each knowledge base this machine is
// signed in to. What a knowledge base holds is the signed-in person's, so a
// cache of it is theirs alone (mcpCacheable).

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

const (
	mcpResourcePrefix   = "semiont://kb/"
	mcpResourceTemplate = mcpResourcePrefix + "{kb}/resources/{resourceId}"
)

// mcpResourceURI names a knowledge base's resource. The key is escaped as a
// URI template's simple expansion escapes it: `:` and `/` too.
func mcpResourceURI(kb string, resource api.ResourceId) string {
	return mcpResourcePrefix + strings.ReplaceAll(url.PathEscape(kb), ":", "%3A") + "/resources/" + resource.String()
}

// mcpResourceOf is the knowledge base and the resource uri names.
func mcpResourceOf(uri string) (kb string, resource api.ResourceId, err error) {
	named, isOurs := strings.CutPrefix(uri, mcpResourcePrefix)
	escaped, id, found := strings.Cut(named, "/resources/")
	if !isOurs || !found {
		return "", resource, mcp.ResourceNotFoundError(uri)
	}
	if kb, err = url.PathUnescape(escaped); err != nil {
		return "", resource, mcp.ResourceNotFoundError(uri)
	}
	if resource, err = api.ParseResourceId(id); err != nil {
		return "", resource, mcp.ResourceNotFoundError(uri)
	}
	return kb, resource, nil
}

// mediaTypeOf is a resource's media type: the first of the formats it is
// available in; "" when it states none.
func mediaTypeOf(descriptor api.ResourceDescriptor) string {
	if descriptor.AvailableFormats == nil || len(*descriptor.AvailableFormats) == 0 {
		return ""
	}
	return (*descriptor.AvailableFormats)[0]
}

// resourceLink is a link a tool's answer gives to a resource it names.
func resourceLink(kb string, descriptor api.ResourceDescriptor) *mcp.ResourceLink {
	return &mcp.ResourceLink{URI: mcpResourceURI(kb, descriptor.Id), Name: descriptor.Name, MIMEType: mediaTypeOf(descriptor)}
}

func addMCPResources(server *mcp.Server, sessions *launcher.Sessions) {
	server.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: mcpResourceTemplate,
		Name:        "resource",
		Title:       "A knowledge base's resource",
		Description: "A resource of a knowledge base this machine is signed in to, by the knowledge base's key and the resource's id.",
	}, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return readMCPResource(ctx, sessions, request.Params.URI)
	})
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if method != "resources/list" {
				return next(ctx, method, request)
			}
			return listMCPResources(ctx, sessions)
		}
	})
}

func readMCPResource(ctx context.Context, sessions *launcher.Sessions, uri string) (*mcp.ReadResourceResult, error) {
	kb, resource, err := mcpResourceOf(uri)
	if err != nil {
		return nil, err
	}
	session, err := mcpSession(sessions, kb)
	if err != nil {
		return nil, err
	}
	c := session.Client()
	descriptor, err := c.Browse.Resource(resource).Fresh(ctx)
	if err != nil {
		return nil, c.Refusal(err)
	}
	text, err := c.Browse.ResourceContent(ctx, resource)
	if err != nil {
		return nil, c.Refusal(err)
	}
	return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: mediaTypeOf(descriptor), Text: text}}}, nil
}

// listMCPResources is the first page of each knowledge base's resources. One
// that cannot be listed is left out, and why is said on stderr: the list is a
// convenience, and every tool says for itself what it could not reach.
func listMCPResources(ctx context.Context, sessions *launcher.Sessions) (*mcp.ListResourcesResult, error) {
	known, err := launcher.SignedInKnowledgeBases()
	if err != nil {
		return nil, err
	}
	listed := &mcp.ListResourcesResult{Resources: []*mcp.Resource{}, Cacheable: mcp.Cacheable{CacheScope: "private"}}
	for _, kb := range known {
		session, err := mcpSession(sessions, kb.Key)
		if err != nil {
			fmt.Fprintf(os.Stderr, "semiont mcp: %s's resources are not listed: %v\n", kb.Key, err)
			continue
		}
		c := session.Client()
		page, err := c.Browse.Resources(semiont.ResourceFilters{}).Fresh(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "semiont mcp: %s's resources are not listed: %v\n", kb.Key, c.Refusal(err))
			continue
		}
		for _, descriptor := range page.Resources {
			listed.Resources = append(listed.Resources, &mcp.Resource{URI: mcpResourceURI(kb.Key, descriptor.Id), Name: descriptor.Name, MIMEType: mediaTypeOf(descriptor)})
		}
	}
	return listed, nil
}
