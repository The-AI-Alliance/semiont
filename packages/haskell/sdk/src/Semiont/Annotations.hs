{-# LANGUAGE OverloadedStrings #-}
-- | Typed readers and reproducible builders of W3C annotations. All offsets
-- count Unicode code points. A caller supplies the creation time.
module Semiont.Annotations
  ( QuotedText(..), TextSpan(..), ReconciledSpan(..), AnchorMethod(..), MatchQuality(..)
  , SpanRefusedError(..), SpanRefusalCode(..), Spanned(..)
  , bodySource, isBodyResolved, targetSource, targetSelector, isHighlight, isReference
  , isAssessment, isComment, isTag, commentText, isStubReference, isResolvedReference
  , textQuoteSelector, textPositionSelector, svgSelector, fragmentSelector, exactText
  , annotationExactText, entityTypes, tagCategory, tagSchemaId
  , reconcile, annotationOfSpan, annotationOfResource
  ) where

import Control.Exception (Exception, throwIO)
import Control.Monad (unless, forM_)
import Data.Aeson (toJSON)
import Data.Maybe (isJust, listToMaybe, mapMaybe)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Time (UTCTime, defaultTimeLocale, formatTime)
import qualified Semiont.Internal.Annotations.Id as Id
import qualified Semiont.Internal.Annotations.Pdf as Pdf
import Semiont.Internal.Annotations.Spans (reconcile, between, collapsed)
import Semiont.ErrorCodes (SpanRefusalCode(..))
import Semiont.Types hiding (tagSchemaId)

data SpanRefusedError = SpanRefusedError
  { spanRefusedCode :: SpanRefusalCode
  , spanRefusedMessage :: Text
  } deriving (Eq, Show)
instance Exception SpanRefusedError

data Spanned = TextContent Text | PdfContent AnchoredText deriving (Eq, Show)

bodies :: Maybe AnnotationBodies -> [AnnotationBody]
bodies Nothing=[]
bodies (Just (AnnotationBodiesBranch1 body))=[body]
bodies (Just (AnnotationBodiesBranch2 body))=body
selectors :: AnnotationSelector -> [Selector]
selectors (AnnotationSelectorBranch1 selector)=[selector]
selectors (AnnotationSelectorBranch2 values)=values
bodySource :: Maybe AnnotationBodies -> Maybe ResourceId
bodySource = listToMaybe . mapMaybe source . bodies
  where source (AnnotationBodyBranch2 resource)=Just (specificResourceSource resource); source _=Nothing
isBodyResolved :: Maybe AnnotationBodies -> Bool
isBodyResolved = isJust . bodySource
targetSource :: AnnotationTargetInline -> ResourceId
targetSource (AnnotationTargetInlineBranch1 resource)=resource
targetSource (AnnotationTargetInlineBranch2 target)=annotationTargetSource target
targetSelector :: AnnotationTargetInline -> Maybe AnnotationSelector
targetSelector (AnnotationTargetInlineBranch1 _)=Nothing
targetSelector (AnnotationTargetInlineBranch2 target)=annotationTargetSelector target
isHighlight, isReference, isAssessment, isComment, isTag :: Annotation -> Bool
isHighlight = (==MotivationHighlighting) . annotationMotivation
isReference = (==MotivationLinking) . annotationMotivation
isAssessment = (==MotivationAssessing) . annotationMotivation
isComment = (==MotivationCommenting) . annotationMotivation
isTag = (==MotivationTagging) . annotationMotivation
commentText :: Annotation -> Maybe Text
commentText annotation | isComment annotation = case bodies (annotationBody annotation) of AnnotationBodyBranch1 body:_ -> Just (textualBodyValue body); _->Nothing
                       | otherwise=Nothing
isStubReference, isResolvedReference :: Annotation -> Bool
isStubReference annotation=isReference annotation && not (isBodyResolved (annotationBody annotation))
isResolvedReference annotation=isReference annotation && isBodyResolved (annotationBody annotation)
textQuoteSelector :: AnnotationSelector -> Maybe TextQuoteSelector
textQuoteSelector = listToMaybe . mapMaybe select . selectors
  where select (SelectorBranch2 value)=Just value; select _=Nothing
textPositionSelector :: AnnotationSelector -> Maybe TextPositionSelector
textPositionSelector = listToMaybe . mapMaybe select . selectors
  where select (SelectorBranch1 value)=Just value; select _=Nothing
svgSelector :: AnnotationSelector -> Maybe SvgSelector
svgSelector = listToMaybe . mapMaybe select . selectors
  where select (SelectorBranch3 value)=Just value; select _=Nothing
fragmentSelector :: AnnotationSelector -> Maybe FragmentSelector
fragmentSelector = listToMaybe . mapMaybe select . selectors
  where select (SelectorBranch4 value)=Just value; select _=Nothing
exactText :: Maybe AnnotationSelector -> Text
exactText selector=maybe "" textQuoteSelectorExact (selector >>= textQuoteSelector)
annotationExactText :: Annotation -> Text
annotationExactText = exactText . targetSelector . annotationTarget
textsFor :: BodyPurpose -> Annotation -> [Text]
textsFor purpose annotation=[textualBodyValue body | AnnotationBodyBranch1 body<-bodies (annotationBody annotation),textualBodyPurpose body==Just purpose]
entityTypes :: Annotation -> [Text]
entityTypes = filter (not . Text.null) . textsFor BodyPurposeTagging
tagCategory, tagSchemaId :: Annotation -> Maybe Text
tagCategory annotation=if isTag annotation then listToMaybe (textsFor BodyPurposeTagging annotation) else Nothing
tagSchemaId annotation=if isTag annotation then listToMaybe (textsFor BodyPurposeClassifying annotation) else Nothing

built :: IO UTCTime -> ResourceId -> Motivation -> Text -> AnnotationTarget -> Maybe Agent -> Maybe AnnotationBodies -> IO Annotation
built wall resource motivation anchor target generator body = do
  identity <- either (ioError . userError) pure (Id.annotationIdFor resource motivation anchor (toJSON <$> body))
  instant <- wall
  let created=Text.pack (formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%S%3QZ" instant)
  pure (Annotation AnnotationU40_contextHttpU3a_U2f_U2f_wwwU2e_w3U2e_orgU2f_nsU2f_annoU2e_jsonld body created Nothing
    (AnnotationGeneratorBranch1 <$> generator) identity Nothing motivation (AnnotationTargetInlineBranch2 target) AnnotationTypeAnnotation Nothing mempty)

annotationOfResource :: IO UTCTime -> ResourceId -> Motivation -> Maybe Agent -> Maybe AnnotationBodies -> IO Annotation
annotationOfResource wall resource motivation generator body =
  built wall resource motivation "" (AnnotationTarget Nothing resource Nothing mempty) generator body

annotationOfSpan :: IO UTCTime -> Spanned -> TextSpan -> ResourceId -> Motivation -> Agent -> Maybe AnnotationBodies -> IO Annotation
annotationOfSpan wall content spanValue resource motivation generator body = do
  let whole=case content of TextContent value->value; PdfContent value->anchoredTextText value
      lengthInPoints=fromIntegral (Text.length whole)::Scientific
      valid start end = start>=0 && end>=start && end<=lengthInPoints
        &&fromInteger (floor start)==start &&fromInteger (floor end)==end
      refuse code message=throwIO (SpanRefusedError code message)
  case content of
    TextContent _ -> pure ()
    PdfContent anchored -> forM_ (anchoredTextItems anchored) $ \item ->
      unless (valid (fromInteger (pdfTextItemStart item)) (fromInteger (pdfTextItemEnd item)))
        (refuse SpanRefusalItemOutOfRange "An anchored-text item is not a stretch of its text")
  unless (valid (textSpanStart spanValue) (textSpanEnd spanValue))
    (refuse SpanRefusalSpanOutOfRange "The offsets are not a span of the text")
  let start=floor (textSpanStart spanValue)::Integer
      end=floor (textSpanEnd spanValue)::Integer
      exact=textSpanExact spanValue
  places <- case content of
    TextContent _ -> do
      unless (between whole (fromInteger start) (fromInteger end)==exact)
        (refuse SpanRefusalExactMismatch "The span's words differ from the text between its offsets")
      pure [SelectorBranch1 (TextPositionSelector end start TextPositionSelectorTypeTextPositionSelector mempty)]
    PdfContent anchored -> do
      let (overlapping,rectangles)=Pdf.locate anchored start end
      unless (not (null rectangles)) (refuse SpanRefusalNothingLocated "No anchored-text item overlaps the span")
      let covered=between whole (fromInteger (minimum (map pdfTextItemStart overlapping))) (fromInteger (maximum (map pdfTextItemEnd overlapping)))
      unless (collapsed exact `Text.isInfixOf` collapsed covered)
        (refuse SpanRefusalExactNotCovered "The overlapping items do not cover the span's words")
      pure [SelectorBranch4 (FragmentSelector (Just "http://tools.ietf.org/rfc/rfc3778") FragmentSelectorTypeFragmentSelector (Pdf.fragmentOf rectangle) mempty) | rectangle<-rectangles]
  forM_ (textSpanPrefix spanValue) $ \prefix -> unless (prefix `Text.isSuffixOf` Text.take (fromInteger start) whole)
    (refuse SpanRefusalPrefixMismatch "The span's prefix differs from the text before it")
  forM_ (textSpanSuffix spanValue) $ \suffix -> unless (suffix `Text.isPrefixOf` Text.drop (fromInteger end) whole)
    (refuse SpanRefusalSuffixMismatch "The span's suffix differs from the text after it")
  let nonempty= (>>= \value->if Text.null value then Nothing else Just value)
      quote=SelectorBranch2 (TextQuoteSelector exact (nonempty (textSpanPrefix spanValue)) (nonempty (textSpanSuffix spanValue)) TextQuoteSelectorTypeTextQuoteSelector mempty)
      target=AnnotationTarget (Just (AnnotationSelectorBranch2 (places++[quote]))) resource (Just AnnotationTargetTypeSpecificResource) mempty
      anchor=Text.pack (show start)<> ":"<>Text.pack (show end)<> ":"<>exact
  built wall resource motivation anchor target (Just generator) body
