//! The first fault of a value as one of the protocol's shapes. Every SDK
//! holds what it reads to the table of what each component schema requires
//! (`SCHEMAS`, which the build writes from src/required-schemas.json, by the
//! rules of packages/codegen/schemas/required-shapes.mjs) before it decodes it, and
//! names the first fault it finds the same way: a member the value lacks, or
//! one that is not what its schema allows. What serde refuses that the table
//! does not state is a fault of the value itself, and nothing of serde's own
//! account is said: it shows what it was given.

use crate::types::Schema;
use serde_json::{Map, Value};
use std::fmt;

/// A kind of JSON value, as a schema names it. An integer is a number with no
/// fractional part.
pub(crate) enum Kind {
    Object,
    Array,
    String,
    Integer,
    Number,
    Boolean,
    Null,
}

/// A value a shape lists: the value is one of them.
pub(crate) enum Listed {
    Text(&'static str),
    Number(f64),
    Boolean(bool),
}

impl Listed {
    /// Whether `value` is this one: a number is one equal to it in value.
    fn is(&self, value: &Value) -> bool {
        match (self, value) {
            (Listed::Text(one), Value::String(held)) => one == held,
            (Listed::Number(one), Value::Number(held)) => held.as_f64() == Some(*one),
            (Listed::Boolean(one), Value::Bool(held)) => one == held,
            _ => false,
        }
    }
}

/// One step of a pattern: at least `min` of a text's next code points, and
/// at most `max` (none: any number), each in one of the ranges `of`, from and
/// to, both included.
pub(crate) struct Step {
    pub(crate) of: &'static [(u32, u32)],
    pub(crate) min: usize,
    pub(crate) max: Option<usize>,
}

impl Step {
    fn holds(&self, point: char) -> bool {
        self.of
            .iter()
            .any(|(from, to)| (*from..=*to).contains(&u32::from(point)))
    }
}

/// The member whose value names the variant a union is.
pub(crate) struct Discriminator {
    pub(crate) property: &'static str,
    pub(crate) mapping: &'static [(&'static str, usize)],
}

/// What a value must be: packages/codegen/schemas/required-shapes.mjs states
/// what each part means. A part the table does not state is `NONE`'s: no kinds allow
/// any, and an empty list holds nothing.
pub(crate) struct Shape {
    pub(crate) reference: Option<&'static str>,
    pub(crate) kinds: Option<&'static [Kind]>,
    pub(crate) enumeration: Option<&'static [Listed]>,
    pub(crate) pattern: Option<&'static [Step]>,
    pub(crate) min_length: Option<usize>,
    pub(crate) max_length: Option<usize>,
    pub(crate) minimum: Option<f64>,
    pub(crate) maximum: Option<f64>,
    pub(crate) min_items: Option<usize>,
    pub(crate) max_items: Option<usize>,
    pub(crate) required: &'static [&'static str],
    pub(crate) members: &'static [(&'static str, Shape)],
    /// The only members an object may carry; none, where it may carry any.
    pub(crate) closed: Option<&'static [&'static str]>,
    pub(crate) items: Option<&'static Shape>,
    pub(crate) values: Option<&'static Shape>,
    pub(crate) one_of: &'static [Shape],
    pub(crate) discriminator: Option<Discriminator>,
    pub(crate) all_of: &'static [Shape],
}

/// The shape that states nothing.
pub(crate) const NONE: Shape = Shape {
    reference: None,
    kinds: None,
    enumeration: None,
    pattern: None,
    min_length: None,
    max_length: None,
    minimum: None,
    maximum: None,
    min_items: None,
    max_items: None,
    required: &[],
    members: &[],
    closed: None,
    items: None,
    values: None,
    one_of: &[],
    discriminator: None,
    all_of: &[],
};

include!(concat!(env!("OUT_DIR"), "/required.rs"));

/// Why a value is refused at a member.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    /// The value does not carry the member, or the member holds null where it
    /// may not.
    Lacks,
    /// The member is not what its schema allows (of another kind, another
    /// value, form or size), or is one a closed object does not name.
    Malformed,
}

/// The first thing wrong with a value: the way to the member it is at (the
/// names of the members it is within, and its own, joined by dots; empty for
/// the value itself), and why.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Fault {
    pub(crate) member: String,
    pub(crate) reason: Reason,
}

impl Fault {
    /// The fault of a value serde refuses that has no fault the table
    /// states: the value itself is malformed.
    pub(crate) fn undecoded() -> Self {
        Fault {
            member: String::new(),
            reason: Reason::Malformed,
        }
    }
}

/// What every SDK says of the fault.
impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.reason {
            Reason::Lacks => write!(f, "it has no `{}`", self.member),
            Reason::Malformed if self.member.is_empty() => f.write_str("it is malformed"),
            Reason::Malformed => write!(f, "its `{}` is malformed", self.member),
        }
    }
}

/// What the component schema `name` requires of a value.
pub(crate) fn schema(name: &str) -> &'static Shape {
    SCHEMAS
        .binary_search_by(|(named, _)| (*named).cmp(name))
        .map(|at| &SCHEMAS[at].1)
        .unwrap_or_else(|_| panic!("{name} is no component schema of the spec"))
}

fn resolved(shape: &'static Shape) -> &'static Shape {
    match shape.reference {
        Some(name) => resolved(schema(name)),
        None => shape,
    }
}

/// Whether `kinds` allow `value`: none allow any.
fn allows(kinds: Option<&[Kind]>, value: &Value) -> bool {
    kinds.is_none_or(|kinds| {
        kinds.iter().any(|kind| match (kind, value) {
            (Kind::Object, Value::Object(_))
            | (Kind::Array, Value::Array(_))
            | (Kind::String, Value::String(_))
            | (Kind::Number, Value::Number(_))
            | (Kind::Boolean, Value::Bool(_))
            | (Kind::Null, Value::Null) => true,
            (Kind::Integer, Value::Number(number)) => {
                number.is_i64()
                    || number.is_u64()
                    || number.as_f64().is_some_and(|n| n.fract() == 0.0)
            }
            _ => false,
        })
    })
}

fn within(way: &str, name: &str) -> String {
    if way.is_empty() {
        name.to_owned()
    } else {
        format!("{way}.{name}")
    }
}

fn malformed(way: &str) -> Fault {
    Fault {
        member: way.to_owned(),
        reason: Reason::Malformed,
    }
}

/// Whether `count` is at least `least` and at most `most`, where each is
/// stated.
fn counted(least: Option<usize>, count: usize, most: Option<usize>) -> bool {
    least.is_none_or(|least| count >= least) && most.is_none_or(|most| count <= most)
}

/// Whether `points` are of `steps`: the first step takes as many of them as
/// it may, and gives them back one by one until the steps after it take the
/// rest.
fn matches(steps: &[Step], points: &[char]) -> bool {
    let Some((first, rest)) = steps.split_first() else {
        return points.is_empty();
    };
    let most = first.max.map_or(points.len(), |max| max.min(points.len()));
    let taken = points[..most]
        .iter()
        .take_while(|point| first.holds(**point))
        .count();
    (first.min..=taken)
        .rev()
        .any(|count| matches(rest, &points[count..]))
}

/// Whether `value` is one of `shape`'s values, a text is of its pattern and
/// has as many code points as it allows, a number is within its bounds, and
/// an array has as many items as it allows.
fn is_as_stated(shape: &Shape, value: &Value) -> bool {
    if let Some(listed) = shape.enumeration
        && !listed.iter().any(|one| one.is(value))
    {
        return false;
    }
    match value {
        Value::String(text) => {
            let points: Vec<char> = text.chars().collect();
            counted(shape.min_length, points.len(), shape.max_length)
                && shape.pattern.is_none_or(|steps| matches(steps, &points))
        }
        Value::Number(number) => number.as_f64().is_some_and(|number| {
            shape.minimum.is_none_or(|least| number >= least)
                && shape.maximum.is_none_or(|most| number <= most)
        }),
        Value::Array(items) => counted(shape.min_items, items.len(), shape.max_items),
        _ => true,
    }
}

/// The first fault `value` has as a value of `shape`, from `way`.
fn fault_at(shape: &'static Shape, value: &Value, way: &str) -> Option<Fault> {
    let own = resolved(shape);
    if !allows(own.kinds, value) || !is_as_stated(own, value) {
        return Some(malformed(way));
    }
    if let Value::Object(object) = value
        && let Some(fault) = fault_of_members(own, object, way)
    {
        return Some(fault);
    }
    if let (Value::Array(items), Some(item)) = (value, own.items)
        && let Some(fault) = items.iter().find_map(|held| fault_at(item, held, way))
    {
        return Some(fault);
    }
    if !own.one_of.is_empty()
        && let Some(fault) = fault_of_one_of(own, value, way)
    {
        return Some(fault);
    }
    own.all_of
        .iter()
        .find_map(|part| fault_at(part, value, way))
}

/// The first fault of an object in the members `shape` requires, in what its
/// members are, in the members it may not carry, and in its values.
fn fault_of_members(
    shape: &'static Shape,
    object: &Map<String, Value>,
    way: &str,
) -> Option<Fault> {
    for name in shape.required {
        let member = shape.members.iter().find(|(named, _)| named == name);
        let lacking = match object.get(*name) {
            None => true,
            Some(Value::Null) => {
                member.is_some_and(|(_, member)| !allows(resolved(member).kinds, &Value::Null))
            }
            Some(_) => false,
        };
        if lacking {
            return Some(Fault {
                member: within(way, name),
                reason: Reason::Lacks,
            });
        }
    }
    for (name, member) in shape.members {
        if let Some(held) = object.get(*name).filter(|held| !held.is_null())
            && let Some(fault) = fault_at(member, held, &within(way, name))
        {
            return Some(fault);
        }
    }
    if let Some(closed) = shape.closed
        && let Some(unnamed) = object
            .keys()
            .filter(|name| !closed.contains(&name.as_str()))
            .min()
    {
        return Some(malformed(&within(way, unnamed)));
    }
    let values = shape.values?;
    let mut keys: Vec<&String> = object.keys().collect();
    keys.sort();
    keys.into_iter()
        .find_map(|key| fault_at(values, &object[key], way))
}

/// The fault `value` has as one of the variants of `shape`: the variant its
/// discriminator names, or else each variant whose kinds allow it. None when
/// one of them has none; the first one's when each has one; and a value no
/// variant allows is malformed.
fn fault_of_one_of(shape: &'static Shape, value: &Value, way: &str) -> Option<Fault> {
    let named = shape.discriminator.as_ref().and_then(|discriminator| {
        let stated = value.get(discriminator.property)?.as_str()?;
        discriminator
            .mapping
            .iter()
            .find(|(tag, _)| *tag == stated)
            .map(|(_, at)| &shape.one_of[*at])
    });
    let candidates: Vec<&'static Shape> = match named {
        Some(variant) => vec![variant],
        None => shape
            .one_of
            .iter()
            .filter(|variant| allows(resolved(variant).kinds, value))
            .collect(),
    };
    let mut first = None;
    for candidate in &candidates {
        let fault = fault_at(candidate, value, way)?;
        first.get_or_insert(fault);
    }
    first.or_else(|| Some(malformed(way)))
}

/// The first fault `value` has as a value of `shape`, by the rules every SDK
/// reads the table by; nothing when it has none.
pub(crate) fn fault_of(shape: &'static Shape, value: &Value) -> Option<Fault> {
    fault_at(shape, value, "")
}

/// What every SDK says of the first fault `body` has as the component schema
/// `T` is generated from, as it refuses it: "it has no \`member\`", "its
/// \`member\` is malformed", or "it is malformed"; `None` when it has none.
pub fn fault_said<T: Schema>(body: &Value) -> Option<String> {
    fault_of(schema(T::NAME), body).map(|fault| fault.to_string())
}

#[cfg(test)]
mod tests {
    use super::{Fault, Reason, fault_of, fault_said, schema};
    use crate::types::UserResponse;
    use serde_json::json;

    fn malformed(member: &str) -> Option<Fault> {
        Some(Fault {
            member: member.to_owned(),
            reason: Reason::Malformed,
        })
    }

    #[test]
    fn a_value_is_held_to_its_values_its_form_its_size_and_the_members_a_closed_object_names() {
        let cases = [
            ("BusPingMessage", json!({"event": "ping", "data": ""}), None),
            (
                "BusPingMessage",
                json!({"event": "pong", "data": ""}),
                malformed("event"),
            ),
            (
                "BusPingMessage",
                json!({"event": "ping", "data": "x"}),
                malformed("data"),
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": ["did:web:example.org"]}),
                None,
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": ["did:\u{1f600}"]}),
                None,
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": []}),
                malformed("dids"),
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": ["web:example.org"]}),
                malformed("dids"),
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": ["did:web:a b"]}),
                malformed("dids"),
            ),
            (
                "GatherAnnotationOptions",
                json!({"contextWindow": 100.0}),
                None,
            ),
            (
                "GatherAnnotationOptions",
                json!({"contextWindow": 5000}),
                None,
            ),
            (
                "GatherAnnotationOptions",
                json!({"contextWindow": 99}),
                malformed("contextWindow"),
            ),
            (
                "GatherAnnotationOptions",
                json!({"contextWindow": 5001}),
                malformed("contextWindow"),
            ),
            // A closed object: what it describes first, then the first member
            // it does not name, by code point.
            (
                "BrowseProfilesRequest",
                json!({"dids": ["did:web:example.org"], "more": 1}),
                malformed("more"),
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": [], "more": 1}),
                malformed("dids"),
            ),
            (
                "BrowseProfilesRequest",
                json!({"more": 1}),
                Some(Fault {
                    member: "dids".to_owned(),
                    reason: Reason::Lacks,
                }),
            ),
            (
                "BrowseProfilesRequest",
                json!({"dids": ["did:web:example.org"], "\u{1f600}": 1, "\u{ff61}": 1}),
                malformed("\u{ff61}"),
            ),
        ];
        for (name, value, fault) in cases {
            assert_eq!(fault_of(schema(name), &value), fault, "{name}: {value}");
        }
    }

    #[test]
    fn the_first_fault_of_a_body_is_said_as_every_sdk_says_it() {
        let user = json!({"did": "did:web:example.org:users:a", "domain": "example.org", "email": null, "name": null, "image": null});
        assert_eq!(fault_said::<UserResponse>(&user), None);
        assert_eq!(
            fault_said::<UserResponse>(&json!({"did": "did:web:example.org:users:a"})).as_deref(),
            Some("it has no `email`")
        );
        assert_eq!(
            fault_said::<UserResponse>(&json!({"did": "web", "domain": "example.org", "email": null, "name": null, "image": null})).as_deref(),
            Some("its `did` is malformed")
        );
        assert_eq!(
            fault_said::<UserResponse>(&json!("a user")).as_deref(),
            Some("it is malformed")
        );
    }
}
