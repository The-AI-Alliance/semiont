package launcher

// vectorstokens.go — the tokens the Smelter and the Librarian present to a
// Qdrant the launcher runs, minted at each start from the key the launcher
// keeps for it, with the claims protocol/specs/src/vectors/token-cases.json
// states. Qdrant makes and deletes a collection for global manage alone, and
// the Smelter makes its index anew, so the Smelter's token may do anything;
// the Librarian's reads its knowledge base's three collections and nothing
// else.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// vectorsTokenVar: the variable the Smelter and the Librarian are handed their
// token in, for a Qdrant the launcher runs; each one's document names it
// (vectorsTokenEnv).
const vectorsTokenVar = "QDRANT_TOKEN"

// smelterVectorsClaims: the Smelter's claims, global manage.
type smelterVectorsClaims struct {
	Access string `json:"access"`
}

// librarianVectorsClaims: the Librarian's claims, the collections it reads.
type librarianVectorsClaims struct {
	Access []collectionAccess `json:"access"`
}

// collectionAccess: what a token may do with one collection.
type collectionAccess struct {
	Collection string `json:"collection"`
	Access     string `json:"access"`
}

func smelterClaims() smelterVectorsClaims { return smelterVectorsClaims{Access: "m"} }

// librarianClaims: read of each collection of the knowledge base whose DID is
// did, in its words' order.
func librarianClaims(did string) librarianVectorsClaims {
	names := indexCollections(did)
	var claims librarianVectorsClaims
	for _, word := range indexCollectionWords {
		claims.Access = append(claims.Access, collectionAccess{Collection: names[word], Access: "r"})
	}
	return claims
}

// vectorsToken: the token svc of the knowledge base whose DID is did
// presents to the Qdrant whose API key is key — a JSON Web Token signed by
// HS256 with the key, whose claims are svc's and no others. It states no
// expiry: a service runs until it is stopped, and a new key ends every token
// minted from the one before.
func vectorsToken(key, svc, did string) (string, error) {
	var claims []byte
	var err error
	switch svc {
	case "smelter":
		claims, err = json.Marshal(smelterClaims())
	case "librarian":
		if did == "" {
			return "", errors.New("the Librarian's token names its knowledge base's collections, and this knowledge base states no DID")
		}
		claims, err = json.Marshal(librarianClaims(did))
	default:
		return "", fmt.Errorf("%s presents no token to the vector index", svc)
	}
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding.EncodeToString
	signed := enc([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc(claims)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(signed))
	return signed + "." + enc(mac.Sum(nil)), nil
}

// vectorsTokenEnv: the token svc is handed for the vector index, as --env. For
// a Qdrant the launcher runs, it is minted from the key the start loaded
// (withDaemonCredentials); somebody else's Qdrant's tokens are the operator's,
// among the user's variables (vectorsSecrets), and none is minted.
func vectorsTokenEnv(fc flowCtx, svc string) ([]string, error) {
	switch presence := fc.plan.Roles["vectors"].Presence; presence {
	case presenceExternal:
		return nil, nil
	case presenceLauncher, presenceShared:
		key, ok := userEnvVars(fc.userEnv)[daemonCredentials["vectors"].env]
		if !ok {
			return nil, fmt.Errorf("%s's token to the vector index is minted from Qdrant's key, which this start did not load", svc)
		}
		token, err := vectorsToken(key, svc, fc.kb.ident.didWeb())
		if err != nil {
			return nil, err
		}
		return []string{"--env", vectorsTokenVar + "=" + token}, nil
	default:
		return nil, fmt.Errorf("%s reaches a vector index, and this start plans none (%s)", svc, presence)
	}
}
