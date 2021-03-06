/* global window, define */
(function (factory) {
  if (typeof exports !== 'undefined') {
    module.exports = factory();
    module.exports.ObjectAdapter = require('./lib/object-adapter');
  }
  else if (typeof define === 'function' && define.amd) {
    define(['factory-girl-object-adapter'], function (ObjectAdapter) {
      var _factory = factory();
      _factory.ObjectAdapter = ObjectAdapter;
      return _factory;
    });
  }
  else {
    window.Factory = factory();
  }
}(function () {
  var Factory = function () {
    var factory = this,
      factories = {},
      defaultAdapter = new Adapter(),
      adapters = {},
      created = [];

    factory.define = function (name, model, attributes, options) {
      options = options || {};

      factories[name] = {
        model: model,
        attributes: attributes,
        options: options
      };
    };

    var builderProxy = function (fnName) {
      return function () {
        var builder = new Builder();
        return builder[fnName].apply(builder, arguments);
      };
    };

    factory.withOptions = builderProxy('withOptions');
    factory.attrs = builderProxy('attrs');
    factory.build = builderProxy('build');
    factory.buildSync = builderProxy('buildSync');
    factory.buildMany = builderProxy('buildMany');
    factory.create = builderProxy('create');
    factory.createMany = builderProxy('createMany');

    factory.assoc = function (name, key, attrs, buildOptions) {
      attrs = attrs || {};
      buildOptions = buildOptions || {};
      return function (callback) {
        factory.create(name, attrs, buildOptions, function (err, doc) {
          if (err) return callback(err);
          callback(null, key ? doc[key] : doc);
        });
      };
    };

    factory.assocBuild = function(name, key, attrs, buildOptions) {
      attrs = attrs || {};
      buildOptions = buildOptions || {};
      return function(callback) {
        factory.build(name, attrs, buildOptions, function(err, doc) {
          if (err) return callback(err);
          callback(null, key ? doc[key] : doc);
        });
      };
    };

    factory.assocMany = function (name, key, num, attrsArray, buildOptionsArray) {
      if (typeof key === 'number') {
        buildOptionsArray = attrsArray;
        attrsArray = num;
        num = key;
        key = null;
      }

      buildOptionsArray = buildOptionsArray || [];
      attrsArray = attrsArray || [];

      return function (callback) {
        factory.createMany(name, attrsArray, num, buildOptionsArray, function (err, docs) {
          if (err) return callback(err);
          if (key) {
            for (var i = 0; i < docs.length; ++i) {
              docs[i] = docs[i][key];
            }
          }
          callback(null, docs);
        });
      };
    };

    factory.assocBuildMany = function(name, key, num, attrsArray, buildOptionsArray) {
      if (typeof key === 'number') {
        buildOptionsArray = attrsArray;
        attrsArray = num;
        num = key;
        key = null;
      }

      buildOptionsArray = buildOptionsArray || [];
      attrsArray = attrsArray || [];

      return function(callback) {
        factory.buildMany(name, attrsArray, num, buildOptionsArray, function(err, docs) {
          if (err) return callback(err);
          if (key) {
            for (var i = 0; i < docs.length; ++i) {
              docs[i] = docs[i][key];
            }
          }
          callback(null, docs);
        });
      };
    };

    factory.sequence = function (fn) {
      var result;
      var sequenceNum = 1;

      if (!fn || fn.length < 2) {
        result = function () {
          if (fn) {
            return fn(sequenceNum++);
          }
          else {
            return sequenceNum++;
          }
        };
      }
      else {
        result = function (cb) {
          return fn(sequenceNum++, cb);
        };
      }
      return result;
    };

    factory.seq = factory.sequence;

    factory.adapterFor = function (name) {
      return adapters[name] || defaultAdapter;
    };

    factory.setAdapter = function (adapter, name) {
      if (name) {
        adapters[name] = adapter;
      }
      else {
        defaultAdapter = adapter;
      }
    };

    factory.promisify = function (promiseLibrary) {
      var promisify = promiseLibrary.promisify || promiseLibrary.denodeify;
      if (!promisify) throw new Error("No 'promisify' or 'denodeify' method found in supplied promise library");
      var promisified = {};
      for (var i in factory) {
        if (factory.hasOwnProperty(i)) {
          promisified[i] = factory[i];
        }
      }

      var promisifiedBuilderProxy = function (fnName) {
        return function () {
          var builder = new Builder();
          builder.promisify(promisify);
          return builder[fnName].apply(builder, arguments);
        };
      };

      promisified.withOptions = promisifiedBuilderProxy('withOptions');
      promisified.attrs = promisifiedBuilderProxy('attrs');
      promisified.build = promisifiedBuilderProxy('build');
      promisified.buildMany = promisifiedBuilderProxy('buildMany');
      promisified.create = promisifiedBuilderProxy('create');
      promisified.createMany = promisifiedBuilderProxy('createMany');

      promisified.cleanup = promisify(factory.cleanup);

      return promisified;
    };

    factory.cleanup = function (callback) {
      asyncForEach(created.reverse(), function (tuple, cb) {
        var name = tuple[0],
          doc = tuple[1],
          adapter = factory.adapterFor(name),
          model = factories[name].model;
        adapter.destroy(doc, model, cb);
      }, callback);
      created = [];
    };

    var Builder = function () {
      var builder = this;
      builder.options = {};

      builder.promisify = function (promisify) {
        builder.attrs = promisify(builder.attrs);
        builder.build = promisify(builder.build);
        builder.create = promisify(builder.create);
        builder.buildMany = promisify(builder.buildMany);
        builder.createMany = promisify(builder.createMany);
      };

      builder.withOptions = function (options) {
        merge(builder.options, options);
        return builder;
      };

      builder.create = function (name, attrs, buildOptions, callback) {
        if (!factories[name]) {
          return callback(new Error("No factory defined for model '" + name + "'"));
        }

        if (typeof attrs === 'function') {
          callback = attrs;
          attrs = {};
          buildOptions = {};
        } else if (typeof buildOptions === 'function') {
          callback = buildOptions;
          buildOptions = {};
        }

        builder._build(name, attrs, buildOptions, function (err, doc, resultingAttrs) {
          if (err) return callback(err);
          save(name, doc, resultingAttrs, callback);
        });
      };


      // Shrink last parameter from callback
      // for more comfortable work with promises
      function wrapCallback(callback) {
        if (callback) {
          var oldCallback = callback;
          return function (error, doc, attrs) {
            return oldCallback(error, doc);
          }
        }
      }

      builder.attrs = function (name, attrs, buildOptions, callback) {
        if (!factories[name]) {
          return callback(new Error("No factory defined for model '" + name + "'"));
        }

        if (typeof attrs === 'function') {
          callback = attrs;
          attrs = {};
          buildOptions = {};
        } else if (typeof buildOptions === 'function') {
          callback = buildOptions;
          buildOptions = {};
        }

        var definedAttributes = factories[name].attributes;
        if (typeof definedAttributes === 'function') {
          definedAttributes = definedAttributes(buildOptions);
        } else {
          definedAttributes = copy(definedAttributes);
        }

        attrs = merge(definedAttributes, attrs);

        function populateAttrs(attrs, cb1) {
          asyncForEach(keys(attrs), function (key, cb) {
            var fn = attrs[key];
            if (typeof fn === 'function') {
              if (!fn.length) {
                attrs[key] = fn.call(attrs);
                cb();
              }
              else {
                fn.call(attrs, function (err, value) {
                  if (err) return cb(err);
                  attrs[key] = value;
                  cb();
                });
              }
            } else if(typeof fn === 'object') {
              populateAttrs(fn, cb)
            } else {
              cb();
            }
          }, function (err) {
            if (err) return cb1(err);

            cb1(null, attrs);
          });
        }

        populateAttrs(attrs, callback);
      };

      builder.build = function (name, attrs, buildOptions, callback) {
        if (typeof attrs === 'function') {
          callback = attrs;
          attrs = {};
          buildOptions = {};
        } else if (typeof buildOptions === 'function') {
          callback = buildOptions;
          buildOptions = {};
        }

        return builder._build(name, attrs, buildOptions, wrapCallback(callback));
      };

      builder._build = function (name, attrs, buildOptions, callback) {
        if (!factories[name]) {
          return callback(new Error("No factory defined for model '" + name + "'"));
        }

        var model = factories[name].model;

        builder.attrs(name, attrs, buildOptions, function (err, resultingAttrs) {
          if (err) return callback(err);
          var adapter = factory.adapterFor(name),
            doc = adapter.build(model, resultingAttrs);

          if (factories[name].options.afterBuild) {
            factories[name].options.afterBuild.call(
              builder, doc, resultingAttrs, callback);
          } else {
            callback(null, doc, resultingAttrs);
          }
        });
      };

      builder.buildSync = function (name, attrs) {
        if (!factories[name]) {
          throw new Error("No factory defined for model '" + name + "'");
        }
        var model = factories[name].model;
        attrs = merge(copy(factories[name].attributes), attrs);
        var names = keys(attrs);
        for (var i = 0; i < names.length; i++) {
          var key = names[i], fn = attrs[key];
          if (typeof fn == 'function') {
            if (fn.length) {
              throw new Error("buildSync only supports synchronous property functions (with no arguments): the function for '" + name + "." + key + "' expects " + fn.length + " arguments");
            }
            attrs[key] = fn.call(attrs);
          }
        }
        var adapter = factory.adapterFor(name);
        return adapter.build(model, attrs);
      };

      builder.buildMany = function (name, attrsArray, num, callback) {
        var args = parseBuildManyArgs.apply(null, arguments);
        buildMany(args);
      };

      builder.createMany = function (name, attrsArray, num, buildOptionsArray, callback) {
        var args = parseBuildManyArgs.apply(null, arguments),
          results = [];
        callback = args.callback;
        args.callback = function (err, docs, resultingAttrsArray) {
          if (err) return callback(err);
          asyncForEach(docs, function (doc, cb, index) {
            save(name, doc, resultingAttrsArray[index], function (err) {
              if (!err) results[index] = doc;
              cb(err);
            });
          }, function (err) {
            callback(err, results);
          });
        };
        buildMany(args);
      };

      function buildMany(args) {
        var results = [];
        var resultingAttrsArray = [];
        var buildOptions = args.buildOptionsArray;

        asyncForEach(args.attrsArray, function (attrs, cb, index) {
          builder._build(args.name, attrs, buildOptions[index] || {}, function (err, doc, resultingAttrs) {
            if (!err) {
              results[index] = doc;
              resultingAttrsArray[index] = resultingAttrs;
            }
            cb(err);
          });
        }, function (err) {
          args.callback(err, results, resultingAttrsArray);
        });
      }

      function parseBuildManyArgs(name, attrsArray, num, buildOptionsArray, callback) {

        function buildObjectArray(obj, count) {
          var arr = [];
          for(var i = 0; i < count; i++) {
            arr[i] = obj;
          }
          return arr;
        }

        if(attrsArray instanceof Array) {
          // name, attrsArray, callback
          // name, attrsArray, buildOptionsArray, callback
          // name, attrsArray, buildOptionsObject, callback
          // name, attrsArray, num, callback
          // name, attrsArray, num, buildOptionsArray, callback
          // name, attrsArray, num, buildOptionsObject, callback
          if(typeof num === 'function') {
            callback = num;
            num = attrsArray.length;
            buildOptionsArray = new Array(num);
          } else if(num instanceof Array) {
            callback = buildOptionsArray;
            buildOptionsArray = num;
            num = Math.max(attrsArray.length, buildOptionsArray.length);
            attrsArray.length = buildOptionsArray.length = num;
          } else if(typeof num === 'object') {
            callback = buildOptionsArray;
            buildOptionsArray = buildObjectArray(num, attrsArray.length);
            num = attrsArray.length;
          } else if(typeof num === 'number') {
            attrsArray.length = num;
            if(typeof buildOptionsArray === 'function') {
              callback = buildOptionsArray;
              buildOptionsArray = new Array(num);
            } else if(buildOptionsArray instanceof Array) {
              buildOptionsArray.length = num;
            } else if(typeof buildOptionsArray === 'object') {
              buildOptionsArray = buildObjectArray(buildOptionsArray, num);
            } else {
              throw new Error('Invalid parameters type found');
            }
          } else {
            throw new Error('Invalid parameters type found');
          }
        } else if(typeof attrsArray === 'number') {
          // name, num, callback
          // name, num, buildOptionsArray, callback
          // name, num, buildOptionsObject, callback
          if(typeof num === 'function') {
            callback = num;
            num = attrsArray;
            attrsArray = new Array(num);
            buildOptionsArray = new Array(num);
          } else if(num instanceof Array) {
            callback = buildOptionsArray;
            buildOptionsArray = num;
            num = attrsArray;
            attrsArray = new Array(num);
            buildOptionsArray.length = num;
          } else if(typeof num === 'object') {
            callback = buildOptionsArray;
            var buildOption1 = num;
            num = attrsArray;
            buildOptionsArray = buildObjectArray(buildOption1, num);
            attrsArray = new Array(num);
          } else {
            throw new Error('Invalid parameters type found');
          }
        } else if(typeof attrsArray === 'object') {
          // name, Object, num, callback
          // name, Object, num, buildOptionsArray, callback
          // name, Object, num, buildOptionsObject, callback
          attrsArray = buildObjectArray(attrsArray, num);

          if(typeof buildOptionsArray === 'function') {
            callback = buildOptionsArray;
            buildOptionsArray = new Array(num);
          } else if(buildOptionsArray instanceof Array) {
            buildOptionsArray.length = num;
          } else if(typeof buildOptionsArray === 'object') {
            buildOptionsArray = buildObjectArray(buildOptionsArray, num);
          } else {
            throw new Error('Invalid parameters type found');
          }
        }

        return {
          name: name,
          attrsArray: attrsArray,
          num: num,
          buildOptionsArray: buildOptionsArray,
          callback: wrapCallback(callback)
        };
      }

      function save(name, doc, resultingAttrs, callback) {
        var model = factories[name].model;
        factory.adapterFor(name).save(doc, model, function (err) {
          if (err) return callback(err);
          created.push([name, doc]);
          if (factories[name].options.afterCreate) {
            factories[name].options.afterCreate.call(builder, doc, resultingAttrs, callback);
          }
          else {
            callback(err, doc);
          }
        });
      }
    };
  };

  var Adapter = function () {
  };

  Adapter.prototype.build = function (Model, props) {
    var doc = new Model();
    this.set(props, doc, Model);
    return doc;
  };
  Adapter.prototype.get = function (doc, attr, Model) {
    return doc[attr];
  };
  Adapter.prototype.set = function (props, doc, Model) {
    var key;
    for (key in props) {
      if (props.hasOwnProperty(key)) {
        doc[key] = props[key];
      }
    }
  };
  Adapter.prototype.save = function (doc, Model, cb) {
    doc.save(cb);
  };
  /**
   Be aware that the model may have already been destroyed
   */
  Adapter.prototype.destroy = function (doc, Model, cb) {
    doc.destroy(cb);
  };

  var merge = typeof require === 'function' ? require('lodash.merge') : _.merge;

  function copy(obj) {
    var newObj = {};
    if (obj) {
      merge(newObj, obj);
    }
    return newObj;
  }

  function keys(obj) {
    var rv = [], key;
    for (key in obj) {
      if (obj.hasOwnProperty(key)) {
        rv.push(key);
        rv.push(key);
      }
    }
    return rv;
  }

  function asyncForEach(array, handler, callback) {
    var length = array.length,
      index = -1;

    function processNext(err) {
      if (err) return callback(err);
      index++;
      if (index < length) {
        handler(array[index], processNext, index);
      }
      else if (callback) {
        typeof setImmediate === 'function' ? setImmediate(callback) : setTimeout(callback, 0);
      }
    }

    processNext();
  }

  var factory = new Factory();
  factory.Adapter = Adapter;
  factory.Factory = Factory;

  return factory;

}));
