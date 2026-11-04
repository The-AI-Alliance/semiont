package launcher

// qdrantapi.go — what the launcher asks of a Qdrant it runs, with its API
// key: a start, whether a shared one it keeps answers the machine's key; a
// clean, which of a knowledge base's collections it holds, and their delete.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// qdrantBase: the origin of the Qdrant probed at endpoint, its health URL.
func qdrantBase(endpoint string) string {
	return strings.TrimSuffix(endpoint, descriptorFor("vectors", probeDriver("vectors")).health.path)
}

// qdrantAnswer: what Qdrant answers a request it took, with what it answers
// in result.
type qdrantAnswer[T any] struct {
	Result T `json:"result"`
}

// qdrantRequest: a request of the Qdrant at base, with its API key.
func qdrantRequest(method, base, key, path string) (*http.Response, error) {
	req, err := http.NewRequest(method, base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("api-key", key)
	return adminHTTP.Do(req)
}

// qdrantCollections: the names of the collections the Qdrant at base, asked
// with key, holds.
func qdrantCollections(base, key string) ([]string, error) {
	resp, err := qdrantRequest(http.MethodGet, base, key, "/collections")
	if err != nil {
		return nil, fmt.Errorf("listing its collections: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("listing its collections: %s", qdrantRefusal(resp))
	}
	var listed qdrantAnswer[struct {
		Collections []struct {
			Name string `json:"name"`
		} `json:"collections"`
	}]
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		return nil, fmt.Errorf("listing its collections: it answered no list of collections: %w", err)
	}
	var names []string
	for _, c := range listed.Result.Collections {
		names = append(names, c.Name)
	}
	return names, nil
}

// qdrantRefusal: what a Qdrant that refused a request said: its status, and
// the error its envelope states, or the plain text it refuses a key in.
func qdrantRefusal(resp *http.Response) string {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var refused struct {
		Status struct {
			Error string `json:"error"`
		} `json:"status"`
	}
	if json.Unmarshal(body, &refused) == nil && refused.Status.Error != "" {
		return fmt.Sprintf("%s: %s", resp.Status, refused.Status.Error)
	}
	if text := strings.TrimSpace(string(body)); text != "" {
		return fmt.Sprintf("%s: %s", resp.Status, text)
	}
	return resp.Status
}
