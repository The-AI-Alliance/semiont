package semiont

// Bytes over the gateway's HTTP transport, as ContentTransport: an upload
// (POST /resources), a resource's bytes whole or as a stream
// (GET /resources/{id}), its description as linked data
// (GET /resources/{id}/jsonld), its annotations
// (GET /resources/{id}/annotations), and its anchored text
// (GET /resources/{id}/anchored-text). Bytes never ride the bus. And the
// gateway's own operations, as GatewayOperations.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// ContentTransport carries bytes, which never ride the bus, a resource's
// description and annotations, and its anchored text.
type ContentTransport interface {
	// PutBinary uploads a resource's bytes and its fields.
	PutBinary(ctx context.Context, request PutBinaryRequest) *Upload
	// GetBinary reads a resource's bytes, whole, with their media type.
	GetBinary(ctx context.Context, resource api.ResourceId) (Content, error)
	// GetBinaryStream reads a resource's bytes as a stream, with their media
	// type.
	GetBinaryStream(ctx context.Context, resource api.ResourceId) (ContentStream, error)
	// GetResourceGraph reads a resource's description as linked data.
	GetResourceGraph(ctx context.Context, resource api.ResourceId) (api.GetResourceResponse, error)
	// GetAnnotations reads a resource's annotations.
	GetAnnotations(ctx context.Context, resource api.ResourceId) (api.GetAnnotationsResponse, error)
	// GetAnchoredText reads a resource's anchored text, or why there is none.
	GetAnchoredText(ctx context.Context, resource api.ResourceId) (api.AnchoredTextAnswer, error)
}

// GatewayOperations is what a gateway answers for itself.
type GatewayOperations interface {
	// GetCurrentUser is who the gateway says this client's token is.
	GetCurrentUser(ctx context.Context) (api.UserResponse, error)
	// GetMediaToken is a token for reading a resource's media.
	GetMediaToken(ctx context.Context, resource api.ResourceId) (api.MediaTokenResponse, error)
	// GetProtectedResourceMetadata is the gateway's OAuth protected resource
	// metadata.
	GetProtectedResourceMetadata(ctx context.Context) (api.ProtectedResourceMetadata, error)
	// HealthCheck is the gateway reporting itself: alive when it answers a
	// success, with its report when the body is one.
	HealthCheck(ctx context.Context) (report api.HealthResponse, ok bool, err error)
	// GetStatus is the gateway's status.
	GetStatus(ctx context.Context) (api.StatusResponse, error)
}

var _ GatewayOperations = (*HTTPTransport)(nil)

// PutBinaryRequest is an upload: the resource's bytes and its fields. A field
// left at its zero value is not sent.
type PutBinaryRequest struct {
	Name       string
	Bytes      []byte
	Format     string
	StorageURI string
	// EntityTypes is the resource's entity types.
	EntityTypes []string
	Language    string
	// SourceAnnotationID and SourceResourceID name what a generated resource
	// was generated from.
	SourceAnnotationID api.AnnotationId
	SourceResourceID   api.ResourceId
	GenerationPrompt   string
	// Generator is the agent that produced a generated resource's content.
	Generator *api.Agent
	// JobID is the job a worker's upload fulfils.
	JobID           api.JobId
	IsDraft         *bool
	CloneToken      string
	ArchiveOriginal *bool
}

// UploadProgress is how much of an upload has been sent, of how much there
// is.
type UploadProgress struct {
	BytesUploaded int64
	TotalBytes    int64
}

// Upload is an upload under way: its progress as it is sent, and what the
// gateway answers. It is consumed once.
type Upload struct {
	progress *queue[UploadProgress]
	done     chan struct{}
	result   api.CreateResourceResponse
	err      error

	mu       sync.Mutex
	consumed bool
}

// NewUpload is the upload work carries out: work reports how much has been
// sent through report, and returns what the gateway answered. What
// implements ContentTransport makes each upload it starts with it.
func NewUpload(work func(report func(UploadProgress)) (api.CreateResourceResponse, error)) *Upload {
	upload := &Upload{progress: newQueue[UploadProgress](), done: make(chan struct{})}
	go func() {
		defer close(upload.done)
		defer upload.progress.close()
		upload.result, upload.err = work(func(progress UploadProgress) { upload.progress.push(progress) })
	}()
	return upload
}

// Progress is how much has been sent, each time more has, never less than it
// last said, until the upload ends or the loop over it stops.
func (u *Upload) Progress() iter.Seq[UploadProgress] {
	return u.progress.all(nil, func() {})
}

// Wait is what the gateway answers: the new resource's id. A second Wait is
// refused.
func (u *Upload) Wait(ctx context.Context) (api.CreateResourceResponse, error) {
	u.mu.Lock()
	again := u.consumed
	u.consumed = true
	u.mu.Unlock()
	if again {
		return api.CreateResourceResponse{}, fmt.Errorf("an upload's answer is taken once")
	}
	select {
	case <-u.done:
		return u.result, u.err
	case <-ctx.Done():
		return api.CreateResourceResponse{}, ctx.Err()
	}
}

// Content is a resource's bytes, with their media type.
type Content struct {
	Bytes       []byte
	ContentType string
}

// ContentStream is a resource's bytes as they arrive, with their media type.
// Its reader is closed by its caller.
type ContentStream struct {
	Bytes       io.ReadCloser
	ContentType string
}

// HTTPContentTransport is ContentTransport over the gateway an HTTPTransport
// speaks to, with its token, its retry rule and its error stream.
type HTTPContentTransport struct {
	shared *transportShared
}

var _ ContentTransport = (*HTTPContentTransport)(nil)

// NewHTTPContentTransport is content over the gateway transport speaks to.
func NewHTTPContentTransport(transport *HTTPTransport) *HTTPContentTransport {
	return &HTTPContentTransport{shared: transport.shared}
}

// uploadChunk is how much of an upload's body is handed to the connection at
// a time: the grain its progress is reported in.
const uploadChunk = 64 * 1024

// form is an upload's multipart/form-data body: each field under its own
// name, and the bytes as the part `file`.
func form(request PutBinaryRequest) (body []byte, contentType string, err error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	field := func(name, value string) {
		if err == nil {
			err = writer.WriteField(name, value)
		}
	}
	field("name", request.Name)
	field("format", request.Format)
	field("storageUri", request.StorageURI)
	if err != nil {
		return nil, "", err
	}
	header := make(textproto.MIMEHeader)
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(request.Name)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escaped))
	header.Set("Content-Type", request.Format)
	part, err := writer.CreatePart(header)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(request.Bytes); err != nil {
		return nil, "", err
	}
	if len(request.EntityTypes) > 0 {
		encoded, encodeErr := json.Marshal(request.EntityTypes)
		if encodeErr != nil {
			return nil, "", encodeErr
		}
		field("entityTypes", string(encoded))
	}
	for _, text := range []struct{ name, value string }{
		{"language", request.Language},
		{"sourceAnnotationId", request.SourceAnnotationID.String()},
		{"sourceResourceId", request.SourceResourceID.String()},
		{"generationPrompt", request.GenerationPrompt},
		{"jobId", request.JobID.String()},
		{"cloneToken", request.CloneToken},
	} {
		if text.value != "" {
			field(text.name, text.value)
		}
	}
	if request.Generator != nil {
		encoded, encodeErr := json.Marshal(request.Generator)
		if encodeErr != nil {
			return nil, "", encodeErr
		}
		field("generator", string(encoded))
	}
	for _, flag := range []struct {
		name  string
		value *bool
	}{{"archiveOriginal", request.ArchiveOriginal}, {"isDraft", request.IsDraft}} {
		if flag.value != nil {
			field(flag.name, fmt.Sprint(*flag.value))
		}
	}
	if err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

// progressReader hands body to the connection a chunk at a time, reporting
// each to progress. reported is how much of this upload has been reported
// sent: a sending that repeats an earlier one, after a renewed token, reports
// nothing until it has passed that.
type progressReader struct {
	body     []byte
	sent     int64
	reported *int64
	mu       *sync.Mutex
	report   func(UploadProgress)
}

func (p *progressReader) Read(buffer []byte) (int, error) {
	if p.sent >= int64(len(p.body)) {
		return 0, io.EOF
	}
	n := copy(buffer[:min(len(buffer), uploadChunk)], p.body[p.sent:])
	p.sent += int64(n)
	p.mu.Lock()
	if p.sent > *p.reported {
		*p.reported = p.sent
		p.report(UploadProgress{BytesUploaded: p.sent, TotalBytes: int64(len(p.body))})
	}
	p.mu.Unlock()
	return n, nil
}

// PutBinary uploads a resource. Its context abandons it: the connection is
// closed, nothing is reported on the error stream, and it is not sent again.
func (c *HTTPContentTransport) PutBinary(ctx context.Context, putting PutBinaryRequest) *Upload {
	return NewUpload(func(report func(UploadProgress)) (api.CreateResourceResponse, error) {
		busLog(ctx, busPut, "content", map[string]any{"name": putting.Name, "format": putting.Format, "storageUri": putting.StorageURI, "sizeBytes": len(putting.Bytes)}, Envelope{})
		ctx, span := uploading(ctx, putting.Format, len(putting.Bytes))
		defer span.End()
		body, contentType, err := form(putting)
		if err != nil {
			return api.CreateResourceResponse{}, c.shared.failures.report(transportErrorWithoutResponse(fmt.Sprintf("an upload that cannot be written: %v", err), TransportErrorCodeError))
		}
		var reported int64
		var mu sync.Mutex
		return answer[api.CreateResourceResponse](ctx, c.shared, request{
			method: http.MethodPost, path: "/resources", authenticated: true, contentType: contentType,
			body: func() (io.Reader, int64) {
				return &progressReader{body: body, reported: &reported, mu: &mu, report: report}, int64(len(body))
			},
		})
	})
}

// path is where a resource is read. Its id is one segment of the path as it
// is: the rule a ResourceId is held to admits nothing a path reads as its own.
func path(resource api.ResourceId) string { return "/resources/" + resource.String() }

// read is the stored bytes, as they are: no Accept, so the gateway serves them
// with their own media type. The deadline is on their beginning to arrive:
// how long they take after that is how many there are.
func (c *HTTPContentTransport) read(ctx context.Context, resource api.ResourceId) (answered, error) {
	return c.shared.exchange(ctx, request{method: http.MethodGet, path: path(resource), authenticated: true, deadline: c.shared.timing.HttpRequestTimeout})
}

func contentType(response *http.Response) string {
	if stated := response.Header.Get("Content-Type"); stated != "" {
		return stated
	}
	return "application/octet-stream"
}

// interrupted is a read whose bytes stopped coming.
func interrupted(resource api.ResourceId, err error) *TransportError {
	return transportErrorWithoutResponse(fmt.Sprintf("GET %s ended before its bytes did: %v", path(resource), err), TransportErrorCodeUnavailable)
}

// GetBinary reads a resource's bytes, whole.
func (c *HTTPContentTransport) GetBinary(ctx context.Context, resource api.ResourceId) (Content, error) {
	busLog(ctx, busGet, "content", map[string]any{"resourceId": resource}, Envelope{})
	ctx, span := getting(ctx, resource, false)
	defer span.End()
	got, err := c.read(ctx, resource)
	if err != nil {
		return Content{}, err
	}
	defer got.done()
	read, err := io.ReadAll(got.response.Body)
	if err != nil {
		if ctx.Err() != nil {
			return Content{}, ctx.Err()
		}
		return Content{}, c.shared.failures.report(interrupted(resource, err))
	}
	return Content{Bytes: read, ContentType: contentType(got.response)}, nil
}

// streamed reports a read whose bytes stopped coming, and releases the
// request once its reader is closed.
type streamed struct {
	body     io.ReadCloser
	done     func()
	resource api.ResourceId
	shared   *transportShared
	once     sync.Once
}

func (s *streamed) Read(p []byte) (int, error) {
	n, err := s.body.Read(p)
	if err != nil && err != io.EOF {
		return n, s.shared.failures.report(interrupted(s.resource, err))
	}
	return n, err
}

func (s *streamed) Close() error {
	s.once.Do(s.done)
	return nil
}

// GetBinaryStream reads a resource's bytes as a stream; its reader is closed
// by its caller.
func (c *HTTPContentTransport) GetBinaryStream(ctx context.Context, resource api.ResourceId) (ContentStream, error) {
	busLog(ctx, busGet, "content", map[string]any{"resourceId": resource, "stream": true}, Envelope{})
	ctx, span := getting(ctx, resource, true)
	defer span.End()
	got, err := c.read(ctx, resource)
	if err != nil {
		return ContentStream{}, err
	}
	return ContentStream{
		Bytes:       &streamed{body: got.response.Body, done: got.done, resource: resource, shared: c.shared},
		ContentType: contentType(got.response),
	}, nil
}

func (c *HTTPContentTransport) get(resource api.ResourceId, suffix string) request {
	return request{method: http.MethodGet, path: path(resource) + suffix, authenticated: true, deadline: c.shared.timing.HttpRequestTimeout}
}

// GetResourceGraph reads a resource's description as linked data.
func (c *HTTPContentTransport) GetResourceGraph(ctx context.Context, resource api.ResourceId) (api.GetResourceResponse, error) {
	busLog(ctx, busGet, "content", map[string]any{"resourceId": resource, "graph": true}, Envelope{})
	ctx, span := reading(ctx, spanContentGetGraph, resource)
	defer span.End()
	return answer[api.GetResourceResponse](ctx, c.shared, c.get(resource, "/jsonld"))
}

// GetAnnotations reads a resource's annotations.
func (c *HTTPContentTransport) GetAnnotations(ctx context.Context, resource api.ResourceId) (api.GetAnnotationsResponse, error) {
	busLog(ctx, busGet, "content", map[string]any{"resourceId": resource, "annotations": true}, Envelope{})
	ctx, span := reading(ctx, spanContentGetAnnotations, resource)
	defer span.End()
	return answer[api.GetAnnotationsResponse](ctx, c.shared, c.get(resource, "/annotations"))
}

// GetAnchoredText reads a resource's anchored text. The Archivist may hold
// this read while the Smelter settles the content, and the gateway passes
// that wait through: the deadline (Timing.HttpRequestTimeout) outlasts it.
func (c *HTTPContentTransport) GetAnchoredText(ctx context.Context, resource api.ResourceId) (api.AnchoredTextAnswer, error) {
	busLog(ctx, busGet, "content", map[string]any{"resourceId": resource, "anchoredText": true}, Envelope{})
	ctx, span := reading(ctx, spanContentGetAnchoredText, resource)
	defer span.End()
	return answer[api.AnchoredTextAnswer](ctx, c.shared, c.get(resource, "/anchored-text"))
}

func (t *HTTPTransport) operation(method, path string, authenticated bool) request {
	return request{method: method, path: path, authenticated: authenticated, deadline: t.shared.timing.HttpRequestTimeout}
}

// GetCurrentUser is who the gateway says this client's token is.
func (t *HTTPTransport) GetCurrentUser(ctx context.Context) (api.UserResponse, error) {
	return answer[api.UserResponse](ctx, t.shared, t.operation(http.MethodGet, "/api/users/me", true))
}

// GetMediaToken is a token for reading a resource's media.
func (t *HTTPTransport) GetMediaToken(ctx context.Context, resource api.ResourceId) (api.MediaTokenResponse, error) {
	spec := t.operation(http.MethodPost, "/api/tokens/media", true)
	body, err := jsonBody(api.MediaTokenRequest{ResourceId: resource})
	if err != nil {
		return api.MediaTokenResponse{}, t.shared.failures.report(transportErrorWithoutResponse(fmt.Sprintf("a media token request that does not serialize: %v", err), TransportErrorCodeError))
	}
	spec.body, spec.contentType = body, "application/json"
	return answer[api.MediaTokenResponse](ctx, t.shared, spec)
}

// GetProtectedResourceMetadata is the gateway's OAuth protected resource
// metadata, which any caller may read.
func (t *HTTPTransport) GetProtectedResourceMetadata(ctx context.Context) (api.ProtectedResourceMetadata, error) {
	return answer[api.ProtectedResourceMetadata](ctx, t.shared, t.operation(http.MethodGet, "/.well-known/oauth-protected-resource", false))
}

// HealthCheck asks the gateway to report itself. A nil error means it
// answered with a success status: it is alive. Its report is the body, when
// the body is one; ok is false for a success whose body does not read, a live
// gateway behind a schema this client does not know, since calling that down
// would take a gateway offline over a field renamed. Liveness is the status;
// the body is detail.
func (t *HTTPTransport) HealthCheck(ctx context.Context) (report api.HealthResponse, ok bool, err error) {
	spec := t.operation(http.MethodGet, "/api/health", true)
	got, err := t.shared.exchange(ctx, spec)
	if err != nil {
		return api.HealthResponse{}, false, err
	}
	defer got.done()
	reading, cancel := context.WithTimeout(ctx, spec.deadline)
	defer cancel()
	body, err := io.ReadAll(readerWithContext(reading, got.response.Body))
	if err != nil || json.Unmarshal(body, &report) != nil {
		return api.HealthResponse{}, false, nil
	}
	return report, true, nil
}

// GetStatus is the gateway's status.
func (t *HTTPTransport) GetStatus(ctx context.Context) (api.StatusResponse, error) {
	return answer[api.StatusResponse](ctx, t.shared, t.operation(http.MethodGet, "/api/status", true))
}
