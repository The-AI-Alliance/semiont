package readme

import (
	"encoding/json"
	"fmt"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// Ids makes ids from text, and a command of them.
func Ids() error {
	resource, err := api.ParseResourceId("5bcd259ab1464cf68a556bbad21f513f")
	if err != nil {
		return err
	}
	if _, err := api.ParseResourceId("https://kb.example/resources/x"); err != nil {
		fmt.Println(err) // "https://kb.example/resources/x" is not a ResourceId: it does not match ^[A-Za-z0-9_-]{1,128}$
	}
	annotation, err := api.ParseAnnotationId("a-1")
	if err != nil {
		return err
	}
	command, err := json.Marshal(api.MarkDeleteCommand{AnnotationId: annotation, ResourceId: &resource})
	if err != nil {
		return err
	}
	fmt.Println(string(command)) // {"annotationId":"a-1","resourceId":"5bcd259ab1464cf68a556bbad21f513f"}
	// api.MarkDeleteCommand{AnnotationId: resource} does not compile: a ResourceId is not an AnnotationId.
	return nil
}
