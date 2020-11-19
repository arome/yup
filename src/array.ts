import isAbsent from './util/isAbsent';
import isSchema from './util/isSchema';
import printValue from './util/printValue';
import MixedSchema from './mixed';
import { array as locale } from './locale';
import runTests, { RunTest } from './util/runTests';
import { SchemaInnerTypeDescription, SchemaSpec } from './Schema';
import { InternalOptions, Callback, Message, Maybe } from './types';
import ValidationError from './ValidationError';
import Reference from './Reference';
import {
  Asserts,
  Nullability,
  Presence,
  ResolveInput,
  ResolveOutput,
  TypeOf,
  Unset,
} from './util/types';

type RefectorFn = (value: any, index: number, array: any[]) => boolean;

type MaybeArray<T> = Maybe<Maybe<T>[]>;

export function create<TInner extends MixedSchema = MixedSchema>(
  type?: TInner,
) {
  return new ArraySchema(type);
}

type Type<T extends MixedSchema> = T extends MixedSchema<infer TType>
  ? TType
  : never;

export default class ArraySchema<
  T extends MixedSchema = MixedSchema,
  TDefault extends MaybeArray<T> = undefined,
  TNullablity extends Nullability = Unset,
  TPresence extends Presence = Unset
> extends MixedSchema<
  Type<T>[],
  TDefault,
  TNullablity,
  TPresence,
  ResolveInput<TypeOf<T>[], TNullablity, TDefault>,
  ResolveOutput<Asserts<T>[], TNullablity, TPresence, TDefault>
> {
  //

  innerType: T | undefined;

  constructor(type?: T) {
    super({ type: 'array' });

    // `undefined` specifically means uninitialized, as opposed to
    // "no subtype"
    this.innerType = type;

    this.withMutation(() => {
      this.transform(function (values) {
        if (typeof values === 'string')
          try {
            values = JSON.parse(values);
          } catch (err) {
            values = null;
          }

        return this.isType(values) ? values : null;
      });
    });
  }

  private get _subType() {
    return this.innerType;
  }

  protected _typeCheck(v: any): v is any[] {
    return Array.isArray(v);
  }

  protected _cast(_value: any, _opts: InternalOptions) {
    const value = super._cast(_value, _opts);

    //should ignore nulls here
    if (!this._typeCheck(value) || !this.innerType) return value;

    let isChanged = false;
    const castArray = value.map((v, idx) => {
      const castElement = this.innerType!.cast(v, {
        ..._opts,
        path: `${_opts.path || ''}[${idx}]`,
      });
      if (castElement !== v) {
        isChanged = true;
      }

      return castElement;
    });

    return isChanged ? castArray : value;
  }

  protected _validate(
    _value: any,
    options: InternalOptions = {},
    callback: Callback,
  ) {
    let errors = [] as ValidationError[];
    let sync = options.sync;
    let path = options.path;
    let innerType = this.innerType;
    let endEarly = options.abortEarly ?? this.spec.abortEarly;
    let recursive = options.recursive ?? this.spec.recursive;

    let originalValue =
      options.originalValue != null ? options.originalValue : _value;

    super._validate(_value, options, (err, value) => {
      if (err) {
        if (!ValidationError.isError(err) || endEarly) {
          return void callback(err, value);
        }
        errors.push(err);
      }

      if (!recursive || !innerType || !this._typeCheck(value)) {
        callback(errors[0] || null, value);
        return;
      }

      originalValue = originalValue || value;

      // #950 Ensure that sparse array empty slots are validated
      let tests: RunTest[] = new Array(value.length);
      for (let idx = 0; idx < value.length; idx++) {
        let item = value[idx];
        let path = `${options.path || ''}[${idx}]`;

        // object._validate note for isStrict explanation
        let innerOptions = {
          ...options,
          path,
          strict: true,
          parent: value,
          index: idx,
          originalValue: originalValue[idx],
        };

        tests[idx] = (_, cb) =>
          innerType!.validate(
            item,
            innerOptions,
            // @ts-expect-error
            cb,
          );
      }

      runTests(
        {
          sync,
          path,
          value,
          errors,
          endEarly,
          tests,
        },
        callback,
      );
    });
  }

  clone(spec?: SchemaSpec<any>) {
    const next = super.clone(spec);
    next.innerType = this.innerType;
    return next;
  }

  concat(schema: ArraySchema): ArraySchema {
    let next = super.concat(schema) as ArraySchema;

    next.innerType = this.innerType;

    if (schema.innerType)
      next.innerType = next.innerType
        ? next.innerType.concat(schema.innerType)
        : schema.innerType;

    return next;
  }

  of<TInner extends MixedSchema>(
    schema: TInner,
  ): ArraySchema<TInner, undefined, TNullablity, TPresence> {
    // FIXME: this should return a new instance of array without the default to be
    var next = this.clone();

    if (!isSchema(schema))
      throw new TypeError(
        '`array.of()` sub-schema must be a valid yup schema not: ' +
          printValue(schema),
      );

    // FIXME(ts):
    next.innerType = schema as any;

    return next as any;
  }

  length(
    length: number | Reference,
    message: Message<{ length: number }> = locale.length,
  ) {
    return this.test({
      message,
      name: 'length',
      exclusive: true,
      params: { length },
      test(value: Maybe<T[]>) {
        return isAbsent(value) || value.length === this.resolve(length);
      },
    });
  }

  min(min: number | Reference, message?: Message<{ min: number }>) {
    message = message || locale.min;

    return this.test({
      message,
      name: 'min',
      exclusive: true,
      params: { min },
      // FIXME(ts): Array<typeof T>
      test(value: any[]) {
        return isAbsent(value) || value.length >= this.resolve(min);
      },
    });
  }

  max(max: number | Reference, message?: Message<{ max: number }>) {
    message = message || locale.max;
    return this.test({
      message,
      name: 'max',
      exclusive: true,
      params: { max },
      // FIXME(ts): Array<typeof T>
      test(value: any[]) {
        return isAbsent(value) || value.length <= this.resolve(max);
      },
    });
  }

  ensure() {
    return this.default(() => [] as Type<T>[]).transform((val, original) => {
      // We don't want to return `null` for nullable schema
      if (this._typeCheck(val)) return val;
      return original == null ? [] : [].concat(original);
    });
  }

  compact(rejector?: RefectorFn) {
    let reject: RefectorFn = !rejector
      ? (v) => !!v
      : (v, i, a) => !rejector(v, i, a);

    return this.transform((values: any[]) =>
      values != null ? values.filter(reject) : values,
    );
  }

  describe() {
    let base = super.describe() as SchemaInnerTypeDescription;
    if (this.innerType) base.innerType = this.innerType.describe();
    return base;
  }
}

export default interface ArraySchema<
  T extends MixedSchema,
  TDefault extends MaybeArray<T>,
  TNullablity extends Nullability,
  TPresence extends Presence
> extends MixedSchema<
    Type<T>[],
    TDefault,
    TNullablity,
    TPresence,
    ResolveInput<TypeOf<T>[], TNullablity, TDefault>,
    ResolveOutput<Asserts<T>[], TNullablity, TPresence, TDefault>
  > {
  default(): TDefault;
  default<TNextDefault extends any[] = any[]>(
    def: TNextDefault | (() => TNextDefault),
  ): ArraySchema<T, TNextDefault, TNullablity, TPresence>;

  required(): ArraySchema<T, TDefault, TNullablity, 'required'>;
  notRequired(): ArraySchema<T, TDefault, TNullablity, 'optional'>;

  nullable(isNullable?: true): ArraySchema<T, TDefault, 'nullable', TPresence>;
  nullable(
    isNullable: false,
  ): ArraySchema<T, TDefault, 'nonnullable', TPresence>;
}
