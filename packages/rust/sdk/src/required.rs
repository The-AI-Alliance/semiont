//! The first fault of a value as one of the protocol's shapes. Every SDK
//! holds what it reads to the table of what each component schema requires
//! (`SCHEMAS`, which the build writes from src/required-schemas.json, by the
//! rules of packages/codegen/schemas/required-shapes.mjs) before it decodes it, and
//! names the first fault it finds the same way: a member the value lacks, or
//! one of a kind its schema does not allow. What serde refuses that the table
//! does not state is a fault of the value itself, and nothing of serde's own
//! account is said: it shows what it was given.

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
    pub(crate) required: &'static [&'static str],
    pub(crate) members: &'static [(&'static str, Shape)],
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
    required: &[],
    members: &[],
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
    /// The member is of a kind its schema does not allow.
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

/// The first fault `value` has as a value of `shape`, from `way`.
fn fault_at(shape: &'static Shape, value: &Value, way: &str) -> Option<Fault> {
    let own = resolved(shape);
    if !allows(own.kinds, value) {
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
/// members are, and in its values.
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
