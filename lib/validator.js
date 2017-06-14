'use strict';

var assert = require('assert'),
    thing = require('core-util-is'),
    enjoi = require('enjoi'),
    utils = require('./utils');
var Ajv = require('ajv');
var swaggerSchema = require('./swagger-schema.json');
var cloneDeep = require('lodash/cloneDeep');


module.exports = function validator(options) {
    var schemas, types;

    schemas = {
        '#': options.api
    };

    schemas['#'] = options.api;

    // delete this if not called
    options.schemas && Object.keys(options.schemas).forEach(function (key) {
        schemas[key] = options.schemas[key];
    });

    return {
        /**
         * Creates a parameter validator.
         * @param parameter
         * @returns {Function}
         */
        makeAll: function (validators, route) {
            var self = this;

            return Object.keys(validators).map(function (k) {
                var parameter = validators[k];

                return self.make(parameter, route.consumes);
            });
        },

        /**
         * Creates a parameter validator.
         * @param parameter
         * @returns {Function}
         */
        make: function (parameter, consumes) {
            var coerce, template;

            if (parameter.$ref) {
                parameter = refresolver(schemas, parameter.$ref);
            }

            // we don't always need to coerce, eg only when 'true' in querystring
            if (parameter.in) {
                coerce = coercion(parameter, consumes);
            }

            var convertedParam;
            var validationSchema;
            if (parameter.in) {
                convertedParam = convertInParamToJsonSchema(parameter);
                validationSchema = buildJsonSchema(convertedParam, schemas['#'].definitions);
            } else {
                validationSchema = buildJsonSchema(parameter, schemas['#'].definitions);
            }

            // ajv
            var ajv = new Ajv({
                allErrors: true,
                verbose: true,
                meta: false, // optional, to prevent adding draft-06 meta-schema
                // extendRefs: true, // optional, current default is to 'fail', spec behaviour is to 'ignore'
                unknownFormats: 'ignore',  // optional, current default is true (fail)
                // ...
            });
            ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
            // ajv.addMetaSchema(schemas.draft4);
            // ajv._opts.defaultMeta = schemas.draft4.id;
            ajv.removeKeyword('propertyNames');
            ajv.removeKeyword('contains');
            ajv.removeKeyword('const');


            // var ajvValidate = ajv.compile(validationSchema);
            try {
                var ajvValidate = ajv.compile(validationSchema);
            } catch (err) {
                console.log('why not valid', validationSchema);
            }

            return {
                parameter: parameter,
                schema: validationSchema,
                validate: function validateParameter(data, callback) {
                    coerce && data && (data[parameter.name] = coerce(data[parameter.name]));

                    if (parameter.type !== 'string' && data && data.hasOwnProperty(parameter.name) && data[parameter.name] === '' && parameter.hasOwnProperty('allowEmptyValue') && parameter.allowEmptyValue) {
                        // allowEmptyValue so convert '' to null
                        data[parameter.name] = null;
                    }

                    console.log('validation schema', validationSchema);

                    // if (parameter.in === 'query') {
                    //     console.log('in query');
                    // }
                    //
                    // if (parameter.hasOwnProperty('type')) {
                    //     parameter.type = normalizetype(parameter.type);
                    // }
                    //
                    // if ((parameter.in === 'body' || parameter.in === 'formData') && parameter.schema) {
                    //     parameter = refresolver(schemas, parameter.schema.$ref);
                    // }

                    var ajvValid = ajvValidate(data);

                    if (!ajvValid) {
                        var err = {
                            message: '',
                            details: []
                        };
                        ajvValidate.errors.forEach(function(error) {
                            if (error.schemaPath) {
                                err.message += (error.schemaPath + ' ' + JSON.stringify(error.data) + ' ' + error.message + err.message);
                                err.details.push({
                                    message: error.schemaPath + ' ' + error.data + ' ' + error.message,
                                    path:  error.schemaPath
                                });

                            } else {
                                err.message += (error.keyword + ' (' + JSON.stringify(error.data) + ') ' + error.message + ' | ' + err.message);
                                err.details.push({
                                    message: err.message,
                                    path: error.dataPath || error.schemaPath
                                });
                            }
                        });

                        utils.debuglog('%s', err.message);
                        callback(err);
                        return;
                    }

                    callback(null, data);
                }
            };
        }
    };
};

/**
 * Get the object the path references.
 * @param schemas
 * @param value
 * @returns {*}
 */
function refresolver(schemas, value) {
    var id, refschema, path, fragment, paths;

    id = value.substr(0, value.indexOf('#') + 1);
    path = value.substr(value.indexOf('#') + 1);

    if (id) {
        refschema = schemas[id] || schemas[id.substr(0, id.length - 1)];
    }
    else {
        refschema = schemas['#'];
    }

    assert.ok(refschema, 'Can not find schema reference: ' + value + '.');

    fragment = refschema;
    paths = Array.isArray(path) ? path : path.split('/');

    for (var i = 1; i < paths.length && fragment; i++) {
        fragment = typeof fragment === 'object' && fragment[paths[i]];
    }

    return fragment;
}

/**
 * Returns a function that coerces a type.
 * Coercion of doubles and longs are not supported in Javascript and strings should be used instead for 64bit numbers.
 * @param type
 */
function coercion(parameter, consumes) {
    var fn;

    switch (parameter.type) {
        case 'array'  :
            fn = function (data) {
                var sep;

                if (Array.isArray(data)) {
                    return data;
                }

                sep = pathsep(parameter.collectionFormat || 'csv');
                return data.split(sep);
            };
            break;
        case 'integer':
        case 'float':
        case 'long':
        case 'double':
            fn = function (data) {
                if (isNaN(data)) {
                    return data;
                }
                return Number(data);
            };
            break;
        // case 'string':
        //     fn = String;
        //     break;
        case 'byte':
            fn = function (data) {
                return isNaN(data) ? new Buffer(data)[0] : Number(data);
            };
            break;
        case 'boolean':
            fn = function(data) {
                return (data === 'true') || (data === '1') || (data === true);
            };
            break;
        case 'date':
        case 'dateTime':
            fn = Date.parse;
            break;
        case 'file': {
            fn = function (data) {
                return {
                    value: data,
                    consumes: consumes,
                    in: parameter.in
                };
            };
            break;
        }
    }

    if (!fn && parameter.schema) {
        fn = function (data) {
            if (thing.isObject(data) && !Object.keys(data).length) {
                return undefined;
            }
            return data;
        };
    }

    return fn;
}

function normalizetype(type) {
    switch (type) {
        case 'long':
        case 'byte':
            return 'integer';
        case 'float':
        case 'double':
            return 'number';
        case 'date':
        case 'dateTime':
            return 'string';
        default:
            return type;
    }
}

function pathsep(format) {
    switch (format) {
        case 'csv':
            return ',';
        case 'ssv':
            return ' ';
        case 'tsv':
            return '\t';
        case 'pipes':
            return '|';
        case 'multi':
            return '&';
    }
}

function convertInParamToJsonSchema(parameter) {
    var source = parameter.in;
    var key = parameter.name;
    var required = parameter.required;
    var data = cloneDeep(parameter);
    if (data.schema && data.schema.$ref) {
        data.$ref = data.schema.$ref;
        delete data.schema;
    }
    var destination = {
        "additionalProperties": false,
        "properties": {}
    };

    delete data.name;
    delete data.in;
    delete data.required;


    if (required) {
        destination.required = destination.required || [];
        destination.required.push(key);
    }

    destination.properties[key] = data;
    if (parameter.hasOwnProperty('allowEmptyValue') && parameter.allowEmptyValue) {
        destination.properties[key].type = [destination.properties[key].type, "null"]
        delete destination.properties[key].allowEmptyValue;
    }
    return destination;
}

function buildJsonSchema(obj, definitions) {
    var result = cloneDeep(obj);
    result.definitions = definitions;
    return result;
}
