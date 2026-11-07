{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Annotations.Spans (reconcile, occurrencesOf, between, whiteSpace, collapsed) where

import Data.List (find, minimumBy, tails)
import Data.Ord (comparing)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.Vector as Vector
import qualified Semiont.Internal.Generated.UnicodeCase as Unicode
import Semiont.Types

whiteSpace :: Char -> Bool
whiteSpace = Unicode.whiteSpace
collapsed :: Text -> Text
collapsed = Text.intercalate " " . filter (not . Text.null) . Text.split whiteSpace
between :: Text -> Int -> Int -> Text
between text start end = Text.take (end-start) (Text.drop start text)
occurrencesOf :: Text -> Text -> [Int]
occurrencesOf text exact
  | Text.null exact = []
  | otherwise = [offset | (offset,remaining)<-zip [0..] (tails (Text.unpack text)),Text.unpack exact `prefixOf` remaining]
  where prefixOf [] _=True; prefixOf _ []=False; prefixOf (x:xs) (y:ys)=x==y && prefixOf xs ys

normal :: Text -> (Text,Vector.Vector Int)
normal input = let (_,_,pairs)=foldl step (Nothing,False,[]) (zip [0..] (Text.unpack input))
               in (Text.pack (map fst (reverse pairs)),Vector.fromList (map snd (reverse pairs)))
  where
    step (run,started,output) (offset,char)
      | whiteSpace char = (Just (maybe offset id run),started,output)
      | otherwise = (Nothing,True,reverse [(plain,offset) | plain<-replace char] ++ (case (run,started) of (Just first,True)->[(' ',first)]; _->[]) ++ output)
    replace '\x2018'="'"; replace '\x2019'="'"; replace '\x201c'="\""; replace '\x201d'="\""
    replace '\x2014'="--"; replace '\x2013'="-"; replace char=[char]

-- Keep a code-point origin for expansions such as dotted capital I.
lowered :: Text -> (Text,Vector.Vector Int)
lowered input =
  let chars=Text.unpack input
      after=drop 1 (scanr (\char next -> if Unicode.caseIgnorable char then next else Unicode.isCased char) False chars)
      step (before,output) (offset,char,following) =
        let lower=if before && not following then Unicode.finalChar char else Unicode.lowerChar char
            next=if Unicode.caseIgnorable char then before else Unicode.isCased char
        in (next,reverse [(value,offset) | value<-lower]++output)
      (_,backwards)=foldl step (False,[]) (zip3 [0..] chars after)
      pairs=reverse backwards
  in (Text.pack (map fst pairs),Vector.fromList (map snd pairs))

mappedPlaces :: (Text,Vector.Vector Int) -> Text -> [(Int,Int)]
mappedPlaces (text,origins) exact =
  [(origins Vector.! offset,1+origins Vector.! (offset+Text.length exact-1)) | offset<-occurrencesOf text exact]

-- A banded Levenshtein row bounds work by the shared edit allowance. Stretches
-- beyond that band cannot beat an accepted span.
distances :: Vector.Vector Char -> Vector.Vector Char -> Int -> Int -> Int -> Maybe [Int]
distances wanted text start longest allowance = loop 1 initial
  where
    size=Vector.length wanted
    beyond=allowance+1
    width=2*allowance+3
    initial=Vector.generate width (\at -> let count=at-allowance-1 in if count>=0 && count<=min allowance longest then count else beyond)
    loop taken above
      | taken>size = Just (Vector.toList (Vector.slice 1 (width-2) above))
      | otherwise =
          let least=max 0 (taken-allowance)
              most=min longest (taken+allowance)
              values=make least beyond
              make count left
                | count>most = []
                | otherwise =
                    let at=count-taken+allowance+1
                        score=if count==0 then taken else minimum [above Vector.! (at+1)+1,left+1,
                          above Vector.! at+if wanted Vector.! (taken-1)==text Vector.! (start+count-1) then 0 else 1,beyond]
                    in (at,score):make (count+1) score
              row=Vector.replicate width beyond Vector.// values
          in if all ((>allowance) . snd) values then Nothing else loop (taken+1) row

nearest :: Text -> Text -> Maybe (Int,Int)
nearest text wanted
  | allowance==0 = Nothing
  | otherwise = case candidates of []->Nothing; _->let (_,start,count)=minimumBy (comparing rank) candidates in Just (start,start+count)
  where
    allowance=Text.length wanted `div` 20
    size=Text.length wanted
    target=Vector.fromList (Text.unpack wanted)
    whole=Vector.fromList (Text.unpack text)
    lengths=size:concat [[size-away,size+away] | away<-[1..allowance]]
    candidates=[(distance,start,count) | start<-[0..Text.length text-(size-allowance)],
      Just scores<-[distances target whole start (min (size+allowance) (Text.length text-start)) allowance],
      count<-lengths,count<=Text.length text-start,let distance=scores!!(count-size+allowance),distance<=allowance]
    rank (distance,start,count)=(distance,start,abs (count-size),count)

reconcile :: Text -> QuotedText -> Maybe ReconciledSpan
reconcile text quoted
  | Text.null (Text.dropAround whiteSpace exact) = Nothing
  | otherwise = case [(offset,offset+Text.length exact) | offset<-occurrencesOf text exact] of
      [place] -> Just (built place AnchorMethodUniqueU2d_match Nothing)
      places@(first:_) -> case hinted places of
        Just place -> Just (built place AnchorMethodContextU2d_recovered Nothing)
        Nothing -> Just (built first AnchorMethodFirstU2d_ofU2d_many Nothing)
      [] -> do
        (places,quality) <- looser
        place <- case hinted places of Just found->Just found; Nothing->case places of value:_->Just value; _->Nothing
        pure (built place AnchorMethodFuzzyU2d_match (Just quality))
  where
    exact=quotedTextExact quoted
    hint value=value >>= \given -> if Text.null (Text.dropAround whiteSpace given) then Nothing else Just given
    prefix=hint (quotedTextPrefix quoted)
    suffix=hint (quotedTextSuffix quoted)
    fits (start,end)=maybe True (\value->Text.dropAround whiteSpace value `Text.isInfixOf` between text (max 0 (start-max 32 (Text.length value))) start) prefix
      &&maybe True (\value->Text.dropAround whiteSpace value `Text.isInfixOf` Text.take (max 32 (Text.length value)) (Text.drop end text)) suffix
    hinted places=if prefix==Nothing && suffix==Nothing then Nothing else find fits places
    looser=let normalized=mappedPlaces (normal text) (fst (normal exact))
               insensitive=mappedPlaces (lowered text) (fst (lowered exact))
           in if not (null normalized) then Just (normalized,MatchQualityNormalized)
              else if not (null insensitive) then Just (insensitive,MatchQualityCaseU2d_insensitive)
              else (\place->([place],MatchQualityFuzzy)) <$> nearest text exact
    boundary char=whiteSpace char || char `elem` (".,;:!?'\"()[]{}<>/\\"::String)
    buildPrefix start
      | start==0 = Nothing
      | otherwise = let initial=max 0 (start-64)
                        extend offset | offset>max 0 (initial-32) && not (boundary (Text.index text (offset-1))) = extend (offset-1)
                                      | otherwise=offset
                    in Just (between text (extend initial) start)
    buildSuffix end
      | end==Text.length text = Nothing
      | otherwise = let initial=min (Text.length text) (end+64)
                        extend offset | offset<min (Text.length text) (initial+32) && not (boundary (Text.index text offset)) = extend (offset+1)
                                      | otherwise=offset
                    in Just (between text end (extend initial))
    built (start,end) method quality=ReconciledSpan method (fromIntegral end) (between text start end) quality (buildPrefix start) (fromIntegral start) (buildSuffix end) mempty
