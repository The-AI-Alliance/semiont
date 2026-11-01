package semiont_test

// The failures a program outside the SDK makes, as its tests and its own
// sign-in code do.

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

func TestASignInErrorMadeWithTheIssuersStatusIsItsAnswerAndOneMadeWithoutIsNone(t *testing.T) {
	var answered semiont.Error
	if !errors.As(fmt.Errorf("renewing: %w", semiont.NewSignInError(semiont.SignInErrorCodeExchange, "invalid_grant", http.StatusBadRequest)), &answered) {
		t.Fatal("a sign-in error is no semiont.Error")
	}
	if status, ok := answered.Status(); !ok || status != http.StatusBadRequest {
		t.Errorf("the issuer's answer has the status %d, %v", status, ok)
	}
	if answered.ErrorCode() != string(semiont.SignInErrorCodeExchange) || answered.Error() != "invalid_grant" {
		t.Errorf("the issuer's answer is %q: %q", answered.ErrorCode(), answered.Error())
	}

	unanswered := &semiont.SignInError{Code: semiont.SignInErrorCodeExchange, Message: "the network is down"}
	if status, ok := unanswered.Status(); ok {
		t.Errorf("a sign-in nobody answered has the status %d", status)
	}
}
