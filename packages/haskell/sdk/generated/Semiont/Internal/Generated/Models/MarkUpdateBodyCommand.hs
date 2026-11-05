-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkUpdateBodyCommand
  ( MarkUpdateBodyCommand(..)
  , MarkUpdateBodyCommandOperationsItem(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.BodyOperationAdd
import Semiont.Internal.Generated.Models.BodyOperationRemove
import Semiont.Internal.Generated.Models.BodyOperationReplace
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data MarkUpdateBodyCommand = MarkUpdateBodyCommand { markUpdateBodyCommandU5f_userId :: Maybe (UserId), markUpdateBodyCommandAnnotationId :: AnnotationId, markUpdateBodyCommandOperations :: [MarkUpdateBodyCommandOperationsItem], markUpdateBodyCommandResourceId :: ResourceId, markUpdateBodyCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkUpdateBodyCommand where
  parseJSON = checked "MarkUpdateBodyCommand" $ withObject "MarkUpdateBodyCommand" (\fields -> MarkUpdateBodyCommand <$> optional fields "_userId" <*> fields .: "annotationId" <*> fields .: "operations" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "operations", "resourceId"] fields))
instance ToJSON MarkUpdateBodyCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (markUpdateBodyCommandU5f_userId value), [("annotationId", toJSON (markUpdateBodyCommandAnnotationId value))], [("operations", toJSON (markUpdateBodyCommandOperations value))], [("resourceId", toJSON (markUpdateBodyCommandResourceId value))]]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "operations", "resourceId"] (markUpdateBodyCommandAdditionalProperties value)))

data MarkUpdateBodyCommandOperationsItem = MarkUpdateBodyCommandOperationsItemBranch1 (BodyOperationAdd) | MarkUpdateBodyCommandOperationsItemBranch2 (BodyOperationRemove) | MarkUpdateBodyCommandOperationsItemBranch3 (BodyOperationReplace) deriving (Eq, Show)
instance FromJSON MarkUpdateBodyCommandOperationsItem where
  parseJSON = checked "MarkUpdateBodyCommandOperationsItem" $ \value -> (MarkUpdateBodyCommandOperationsItemBranch1 <$> parseJSON value) <|> (MarkUpdateBodyCommandOperationsItemBranch2 <$> parseJSON value) <|> (MarkUpdateBodyCommandOperationsItemBranch3 <$> parseJSON value)
instance ToJSON MarkUpdateBodyCommandOperationsItem where
  toJSON (MarkUpdateBodyCommandOperationsItemBranch1 value) = toJSON value
  toJSON (MarkUpdateBodyCommandOperationsItemBranch2 value) = toJSON value
  toJSON (MarkUpdateBodyCommandOperationsItemBranch3 value) = toJSON value
