// refused: MarkDeleteCommand(String,String,String) has private access in MarkDeleteCommand
// Java makes a model through its builder, never from the text its constructor holds the ids as.
import semiont.types.MarkDeleteCommand;

class ModelConstructed {
    MarkDeleteCommand command = new MarkDeleteCommand(null, "a b", null);
}
