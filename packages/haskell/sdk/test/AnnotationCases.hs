{-# LANGUAGE OverloadedStrings #-}
module AnnotationCases (annotationCases) where

import Control.Exception (try)
import Control.Monad (unless, forM_)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', fromJSON, toJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import qualified Semiont.Annotations as A
import Semiont.ErrorCodes (spanRefusalCode)
import qualified Semiont.Internal.Annotations.Id as Id
import qualified Semiont.Internal.Annotations.Pdf as Pdf
import Semiont.Internal.Annotations.Spans (occurrencesOf,between)
import Semiont.Types
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields)=maybe (error ("missing annotation case member "++Text.unpack name)) id (KM.lookup (Key.fromText name) fields)
member _ _=error "annotation case is not an object"
optional :: Text -> Value -> Value
optional name (Object fields)=maybe Null id (KM.lookup (Key.fromText name) fields)
optional _ _=error "annotation case is not an object"
array :: Value -> [Value]
array (Array values)=toList values
array _=error "annotation cases are not an array"
decode :: FromJSON value => Value -> IO value
decode value=case fromJSON value of Error diagnostic -> ioError (userError (diagnostic++" in "++show value)); Success result->pure result
readTable :: FilePath -> String -> IO Value
readTable root name=Bytes.readFile (root </> "protocol/specs/src" </> name) >>= either (ioError . userError) pure . eitherDecodeStrict'

annotationCases :: FilePath -> IO ()
annotationCases root = do
  readers <- readTable root "annotations/reader-cases.json"
  forM_ (array (member "cases" readers)) $ \row -> do
    annotation <- decode (member "annotation" row)
    let body=annotationBody annotation
        target=annotationTarget annotation
        selector=A.targetSelector target
        actual=Map.fromList
          [("bodySource",toJSON (A.bodySource body)),("isBodyResolved",toJSON (A.isBodyResolved body)),
           ("targetSource",toJSON (A.targetSource target)),("targetSelector",toJSON selector),
           ("isHighlight",toJSON (A.isHighlight annotation)),("isReference",toJSON (A.isReference annotation)),
           ("isAssessment",toJSON (A.isAssessment annotation)),("isComment",toJSON (A.isComment annotation)),
           ("isTag",toJSON (A.isTag annotation)),("commentText",toJSON (A.commentText annotation)),
           ("isStubReference",toJSON (A.isStubReference annotation)),("isResolvedReference",toJSON (A.isResolvedReference annotation)),
           ("exactText",toJSON (A.exactText selector)),("annotationExactText",toJSON (A.annotationExactText annotation)),
           ("textQuoteSelector",toJSON (selector >>= A.textQuoteSelector)),("entityTypes",toJSON (A.entityTypes annotation)),
           ("tagCategory",toJSON (A.tagCategory annotation)),("tagSchemaId",toJSON (A.tagSchemaId annotation))]
    names <- decode (member "readers" readers)
    require "reader runner does not cover the authority" (Map.keysSet actual==Map.keysSet (Map.fromList [(name,()) | name<-names]))
    case member "reads" row of
      Object expected -> forM_ (KM.toList expected) $ \(name,value) ->
        require ("annotation reader differs: "++show (name,row,Map.lookup (Key.toText name) actual)) (Map.lookup (Key.toText name) actual==Just value)
      _ -> ioError (userError "annotation case declares no reads")
  offsets <- readTable root "text/offset-cases.json"
  forM_ (array (member "cases" offsets)) $ \row -> do
    text <- decode (member "text" row)
    count <- decode (member "codePoints" row)
    require "text length does not count Unicode code points" (Text.length text==count)
    forM_ (array (member "spans" row)) $ \spanCase -> do
      exact <- decode (member "exact" spanCase)
      occurrence <- decode (member "occurrence" spanCase)
      start <- decode (member "start" spanCase)
      end <- decode (member "end" spanCase)
      let found=drop (occurrence-1) (occurrencesOf text exact)
      require "forward code-point offsets differ" (case found of first:_->first==start && first+Text.length exact==end; _->False)
      require "reverse code-point offsets differ" (between text start end==exact)
  reconciliation <- readTable root "annotations/reconcile-cases.json"
  forM_ (array (member "cases" reconciliation)) $ \row -> do
    text <- decode (member "text" row)
    quoted <- decode (member "quoted" row)
    let result=toJSON (A.reconcile text quoted)
    require ("reconciled span differs: "++show (row,result)) (result==member "reconciled" row)
  identifiers <- readTable root "annotations/id-cases.json"
  forM_ (array (member "cases" identifiers)) $ \row -> do
    resource <- decode (member "resourceId" row)
    motivation <- decode (member "motivation" row)
    anchor <- decode (member "anchor" row)
    let body=case optional "body" row of Null->Nothing; value->Just value
    identity <- either (ioError . userError) pure (Id.annotationIdFor resource motivation anchor body)
    require "annotation ID differs from canonical derivation" (toJSON identity==member "id" row)
  pdf <- readTable root "annotations/pdf-locate-cases.json"
  forM_ (array (member "cases" pdf)) $ \row -> do
    anchored <- decode (member "anchored" row)
    start <- decode (member "start" (member "span" row))
    end <- decode (member "end" (member "span" row))
    let (overlapping,rectangles)=Pdf.locate anchored start end
    require ("PDF overlapping items differ: "++show row) (toJSON overlapping==member "overlapping" row)
    require ("PDF rectangles differ: "++show (row,rectangles)) (toJSON rectangles==member "rects" row)
    require ("PDF fragments differ: "++show (row,map Pdf.fragmentOf rectangles)) (toJSON (map Pdf.fragmentOf rectangles)==member "fragments" row)
  builders <- readTable root "annotations/builder-cases.json"
  let wall=pure (posixSecondsToUTCTime 1800000000)
      compareBuilt row annotation = do
        require "builder omitted the caller's creation time" (annotationCreated annotation=="2027-01-15T08:00:00.000Z")
        case toJSON annotation of
          Object fields -> require ("annotation builder differs: "++show (row,fields)) (Object (KM.delete "created" fields)==member "annotation" row)
          _ -> ioError (userError "annotation is not an object")
  forM_ (array (member "cases" builders)) $ \row -> do
    content <- case optional "text" row of String value->pure (A.TextContent value); _->A.PdfContent <$> decode (member "anchored" row)
    spanValue <- decode (member "span" row)
    resource <- decode (member "resourceId" row)
    motivation <- decode (member "motivation" row)
    generator <- decode (member "generator" row)
    body <- decode (optional "body" row)
    result <- try (A.annotationOfSpan wall content spanValue resource motivation generator body) :: IO (Either A.SpanRefusedError Annotation)
    case (optional "refused" row,result) of
      (String code,Left refusal) -> require "span refusal differs" (spanRefusalCode (A.spanRefusedCode refusal)==code)
      (Null,Right annotation) -> compareBuilt row annotation
      _ -> ioError (userError ("annotation builder refused/accepted wrongly: "++show (row,result)))
  forM_ (array (member "resources" builders)) $ \row -> do
    resource <- decode (member "resourceId" row)
    motivation <- decode (member "motivation" row)
    generator <- decode (optional "generator" row)
    body <- decode (optional "body" row)
    A.annotationOfResource wall resource motivation generator body >>= compareBuilt row
  putStrLn "PASS every annotation reader, code-point offset, reconciliation, ID, PDF location and builder case"
