# Transform encoding

`scene-engine-transform@1` freezes the shared fixed-point matrix vectors used to verify product rule-space transform helpers.
It is separate from the float32 renderer-neutral scene TRS body.

A rule matrix contains exactly sixteen canonical base-10 integer strings in column-major order and acts on column vectors.
Scale is `1_000_000`; indices 3, 7, and 11 are zero, index 15 is `1000000`, and translation is at 12–14. Each magnitude is at
most `9_000_000_000_000`. JSON numbers, plus signs, leading zeroes, negative zero, decimals, exponents, and nonfinite spellings
are invalid.

World composition is `world(parent) × local(node)`. Each output component performs one exact integer sum and then nearest,
ties-to-even division by scale. Point transforms use homogeneous `w=scale`; directions use `w=0`. Preserve-world reparent is
valid only when both the parent inverse and resulting local matrix are exactly representable on this lattice; singular or
nonrepresentable operations reject the whole product transaction.

The sole vectors are [rule-matrix.canonical-vectors.json](../fixtures/transform-v1/rule-matrix.canonical-vectors.json). They
cover identity, translation, scale, rotation, shear, ties-to-even, parent-only behavior, exact reparent, and malformed values.
Tests and products must read this location; there is no external fixture dependency.
