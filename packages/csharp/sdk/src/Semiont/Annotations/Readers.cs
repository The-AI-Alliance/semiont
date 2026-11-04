using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Annotations;

public static partial class AnnotationTools
{
    public static ResourceId? BodySource(AnnotationBodies? body) => Bodies(body)
        .OfType<AnnotationBody.SpecificResourceCase>().Select(item => (ResourceId?)item.Value.Source).FirstOrDefault();

    public static ResourceId TargetSource(AnnotationTargetValue target) => target switch
    {
        AnnotationTargetValue.ResourceIdCase(var resource) => resource,
        AnnotationTargetValue.AnnotationTargetCase(var specific) => specific.Source,
    };

    public static AnnotationSelector? TargetSelector(AnnotationTargetValue target) =>
        target is AnnotationTargetValue.AnnotationTargetCase(var specific) ? specific.Selector : null;

    public static bool IsBodyResolved(AnnotationBodies? body) => BodySource(body).HasValue;
    public static bool IsHighlight(Annotation annotation) => annotation.Motivation == Motivation.Highlighting;
    public static bool IsReference(Annotation annotation) => annotation.Motivation == Motivation.Linking;
    public static bool IsAssessment(Annotation annotation) => annotation.Motivation == Motivation.Assessing;
    public static bool IsComment(Annotation annotation) => annotation.Motivation == Motivation.Commenting;
    public static bool IsTag(Annotation annotation) => annotation.Motivation == Motivation.Tagging;
    public static bool IsStubReference(Annotation annotation) => IsReference(annotation) && !IsBodyResolved(annotation.Body);
    public static bool IsResolvedReference(Annotation annotation) => IsReference(annotation) && IsBodyResolved(annotation.Body);

    public static string? CommentText(Annotation annotation) =>
        IsComment(annotation) && Bodies(annotation.Body).FirstOrDefault() is AnnotationBody.TextualBodyCase(var body) ? body.Value : null;

    public static TextQuoteSelector? TextQuoteSelector(AnnotationSelector? selector) =>
        Selectors(selector).OfType<Selector.TextQuoteSelectorCase>().FirstOrDefault()?.Value;

    public static TextPositionSelector? TextPositionSelector(AnnotationSelector? selector) =>
        Selectors(selector).OfType<Selector.TextPositionSelectorCase>().FirstOrDefault()?.Value;

    public static SvgSelector? SvgSelector(AnnotationSelector? selector) =>
        Selectors(selector).OfType<Selector.SvgSelectorCase>().FirstOrDefault()?.Value;

    public static FragmentSelector? FragmentSelector(AnnotationSelector? selector) =>
        Selectors(selector).OfType<Selector.FragmentSelectorCase>().FirstOrDefault()?.Value;

    public static string ExactText(AnnotationSelector? selector) => TextQuoteSelector(selector)?.Exact ?? "";
    public static string AnnotationExactText(Annotation annotation) => ExactText(TargetSelector(annotation.Target));
    public static IReadOnlyList<string> EntityTypes(Annotation annotation) => Texts(annotation, BodyPurpose.Tagging)
        .Where(value => value.Length > 0).ToArray();
    public static string? TagCategory(Annotation annotation) => IsTag(annotation) ? Texts(annotation, BodyPurpose.Tagging).FirstOrDefault() : null;
    public static string? TagSchemaId(Annotation annotation) => IsTag(annotation) ? Texts(annotation, BodyPurpose.Classifying).FirstOrDefault() : null;

    private static IEnumerable<string> Texts(Annotation annotation, BodyPurpose purpose) => Bodies(annotation.Body)
        .OfType<AnnotationBody.TextualBodyCase>().Where(item => item.Value.Purpose == purpose).Select(item => item.Value.Value);

    private static IReadOnlyList<AnnotationBody> Bodies(AnnotationBodies? body) => body switch
    {
        null => [],
        AnnotationBodies.AnnotationBodyCase(var single) => [single],
        AnnotationBodies.ArrayCase(var list) => list,
    };

    private static IReadOnlyList<Selector> Selectors(AnnotationSelector? selector) => selector switch
    {
        null => [],
        AnnotationSelector.SelectorCase(var single) => [single],
        AnnotationSelector.ArrayCase(var list) => list,
    };
}
