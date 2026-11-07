{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Annotations.Pdf (locate, fragmentOf) where

import Data.List (sortOn)
import Data.List.NonEmpty (NonEmpty(..))
import qualified Data.List.NonEmpty as NE
import Data.Scientific (Scientific, formatScientific, FPFormat(Fixed), normalize, fromFloatDigits, toRealFloat)
import Data.Text (Text)
import qualified Data.Text as Text
import Semiont.Types

locate :: AnchoredText -> Integer -> Integer -> ([PdfTextItem],[PdfCoordinate])
locate anchored start end
  | start==end = ([],[])
  | otherwise = (overlapping,concat [map (spanning page) (linesOf [item | item<-overlapping,pdfTextItemPage item==page]) | page<-pages])
  where
    overlapping=[item | item<-anchoredTextItems anchored,pdfTextItemStart item<end,pdfTextItemEnd item>start]
    pages=foldl' (\seen item -> if pdfTextItemPage item `elem` seen then seen else seen++[pdfTextItemPage item]) [] overlapping
    linesOf=reverse . foldl' add [] . sortOn (\item->(negate (pdfTextItemY item),pdfTextItemX item))
    add [] item=[item:|[]]
    add groups@(prior:rest) item=if abs (pdfTextItemY item-pdfTextItemY (NE.head prior))<=2
      then (prior<>pure item):rest else (item:|[]):groups
    cut item offset=pdfTextItemX item+fromFloatDigits
      ((toRealFloat (pdfTextItemWidth item)::Double)*fromInteger (offset-pdfTextItemStart item)/fromInteger (pdfTextItemEnd item-pdfTextItemStart item))
    edges item=(if pdfTextItemStart item<start then cut item start else pdfTextItemX item,
      if pdfTextItemEnd item>end then cut item end else pdfTextItemX item+pdfTextItemWidth item)
    spanning page values =
      let line=NE.toList values
          points=map edges line
          left=minimum (map fst points)
          right=maximum (map snd points)
          bottom=minimum (map pdfTextItemY line)
          top=maximum [pdfTextItemY item+pdfTextItemHeight item | item<-line]
      in PdfCoordinate (top-bottom) page (right-left) left bottom mempty


fragmentOf :: PdfCoordinate -> Text
fragmentOf rectangle = "page="<>decimal (pdfCoordinatePage rectangle)<>"&viewrect="<>
  Text.intercalate "," (map decimal [pdfCoordinateX rectangle,pdfCoordinateY rectangle,pdfCoordinateWidth rectangle,pdfCoordinateHeight rectangle])
  where
    decimal :: Scientific -> Text
    decimal value=let written=Text.pack (formatScientific Fixed Nothing (normalize value))
                  in maybe written id (Text.stripSuffix ".0" written)
