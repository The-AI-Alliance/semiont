from semiont.state import BeckonStateUnit


async def show_hover(beckon: BeckonStateUnit) -> None:
    # What it holds now, then each change, until the unit is disposed.
    async for hovered in beckon.hovered_annotation_id:
        match hovered:
            case None:
                print("nothing hovered")
            case annotation:
                print("hovering", annotation)
