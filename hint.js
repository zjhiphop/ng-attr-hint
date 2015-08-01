/*!The MIT License (MIT)

Copyright (c) 2015 Prince John Wesley (princejohnwesley@gmail.com)
**/

'use strict';

var Q = require('q');
var _ = require('lodash');
var fs = require('fs');
var htmlParser = require('htmlparser2');
var through2 = require('through2');

var mutuallyExclusives = [
  ['ng-show', 'ng-hide'],
  ['ng-bind', 'ng-bind-html', 'ng-bind-template'],
  ['href', 'ng-href'],
  ['pattern', 'ng-pattern'],
  ['required', 'ng-required'],
  ['src', 'ng-src']
];

var emptyAttributes = ['ng-cloak', 'ng-transclude'];

//https://github.com/angular/angular.js/blob/master/src/ng/directive/ngOptions.js#L218
//                     //00001111111111000000000002222222222000000000000000000000333333333300000000000000000000000004444444444400000000000005555555555555550000000006666666666666660000000777777777777777000000000000000888888888800000000000000000009999999999
var NG_OPTIONS_REGEXP = /^\s*([\s\S]+?)(?:\s+as\s+([\s\S]+?))?(?:\s+group\s+by\s+([\s\S]+?))?(?:\s+disable\s+when\s+([\s\S]+?))?\s+for\s+(?:([\$\w][\$\w]*)|(?:\(\s*([\$\w][\$\w]*)\s*,\s*([\$\w][\$\w]*)\s*\)))\s+in\s+([\s\S]+?)(?:\s+track\s+by\s+([\s\S]+?))?$/;


// rules

var RULE = {};

RULE.MUTUALLY_EXCLUSIVES = function(attrsInfo, result) {
  var keys = attrsInfo.attrKeys;
  // mutually exclusives
  _.each(mutuallyExclusives, function(me) {
    var common = _.intersection(me, keys);
    if (common.length > 1) {
      result.push({
        location: attrsInfo.attrs.__loc__,
        type: 'error',
        attrs: common,
        message: 'Mutually exclusive attributes ' + common.join(', ')
      });
    }
  });
};


RULE.DUPLICATES = function(attrsInfo, result) {
  // duplicates
  _(attrsInfo.dups)
    .keys()
    .each(function(dup) {
      result.push({
        location: attrsInfo.attrs.__loc__,
        type: 'error',
        attrs: [dup],
        message: 'Duplicate attribute ' + dup
      });
    })
    .value();
};


RULE.NG_TRIM = function(attrsInfo, result) {
  var attrs = attrsInfo.attrs;
  if (!('ng-trim' in attrs) || attrsInfo.tagName !== 'input' || attrs.type !== 'password') return;

  result.push({
    location: attrsInfo.attrs.__loc__,
    type: 'warning',
    attrs: 'ng-trim',
    message: "ng-trim parameter is ignored for input[type=password] controls, which will never trim the input"
  });
};

RULE.NG_INIT = function(attrsInfo, result) {
  var attrs = attrsInfo.attrs;
  if (('ng-repeat' in attrs) || !('ng-init' in attrs)) return;

  result.push({
    location: attrsInfo.attrs.__loc__,
    type: 'warning',
    attrs: 'ng-init',
    message: "The only appropriate use of ngInit is for aliasing special properties of ngRepeat, as seen in the demo below. Besides this case, you should use controllers rather than ngInit to initialize values on a scope."
  });
};

RULE.NG_REPEAT = function(attrsInfo, result) {
  var attrs = attrsInfo.attrs;
  if (!('ng-repeat' in attrs)) return;

  var value = attrs['ng-repeat'];
  value = value.replace(/\(\s*([\S]*)\s*\)/g, '($1)');

  if (value.match(/\strack\s+by\s+(?:[\S]+)\s+(?:[\S]+)/)) {
    result.push({
      location: attrsInfo.attrs.__loc__,
      type: 'error',
      attrs: 'ng-repeat',
      message: "track by must always be the last expression"
    });
  }
};


RULE.NG_OPTIONS = function(attrsInfo, result) {
  var attrs = attrsInfo.attrs;
  if (!('ng-options' in attrs)) return;

  var options = attrs['ng-options'];

  if (!options) return;

  if (!options.match(NG_OPTIONS_REGEXP)) {
    result.push({
      location: attrsInfo.attrs.__loc__,
      type: 'error',
      attrs: 'ng-options',
      message: ["Expected expression in form of '_select_ (as _label_)? for (_key_,)?_value_ in _collection_' but got '",
        options, "'. Element: '<", attrsInfo.tagName, ">'"
      ].join('')
    });
  }

  if (options.match(/\s+as\s+(.*?)\strack\s+by\s/)) {
    result.push({
      location: attrsInfo.attrs.__loc__,
      type: 'error',
      attrs: 'ng-options',
      message: "Do not use select as and track by in the same expression. They are not designed to work together."
    });
  }
};



RULE.EMPTY_NG = function(attrsInfo, result) {
  _.each(attrsInfo.attrKeys, function(key) {
    // empty ng attributes
    if (_.isEmpty(attrsInfo.attrs[key]) &&
      _.startsWith(key, 'ng-') &&
      emptyAttributes.indexOf(key) === -1 &&
      attrsInfo.settings.ignoreAttributes.indexOf(key) === -1) {
      result.push({
        location: attrsInfo.attrs.__loc__,
        type: 'warning',
        attrs: [key],
        message: 'Empty attribute ' + key
      });
    }
  });

};

// rule ends

var RULES = _.keys(RULE);

var fileContent = function(filename) {
  var index = 1;

  function lineContent(content) {
    var lines = content.split(/\r?\n/);
    var start = index;
    index += lines.length - 1;
    return _.map(lines, function(line, idx) {
      return line.replace(/(<[\w\s].*?)(\s|>|\/>)/g, '$1 __loc__="' + filename + ':' + (start + idx) + '" $2');
    }).join('\n');
  }
  return lineContent;
};

var parse = function(settings, content) {
  var result = [];
  var deferred = Q.defer();
  var attrs = {},
    dups = {};
  var p = new htmlParser.Parser({
    onopentag: function(name, attributes) {
      var attrsInfo = {
        tagName: name,
        attrs: attributes,
        dups: dups,
        attrKeys: _.keys(attributes),
        settings: settings
      };

      _.each(RULES, function(rule) {
        RULE[rule](attrsInfo, result);
      })

      attrs = {};
      dups = {};
    },
    onattribute: function(name, value) {
      (name in attrs ? dups : attrs)[name] = value;
    },
    onend: function() {
      deferred.resolve(result);
    }
  });
  p.write(content);
  p.end();
  return deferred.promise;
};


function toDataPromise(stream, transform) {
  var deferred = Q.defer();
  var chunks = [];

  function onData(data) {
    chunks.push(data);
  }

  function onEnd() {
    var data = chunks.join('');
    if (typeof transform === 'function') {
      transform(data).then(deferred.resolve, deferred.reject);
    } else {
      deferred.resolve(data);
    }
  }

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', deferred.reject);

  return deferred.promise;
}

module.exports = function(options, callback) {
  var settings = _.clone(options, true);
  var hasCallback = typeof callback === 'function';
  var deferred = Q.defer();
  var failure = hasCallback ? callback : deferred.reject;
  var failure2 = hasCallback ? callback : Q.reject;

  if (!settings) return failure2(new Error('Empty Settings'));
  if (!settings.files) return failure2(new Error('Empty files property'));

  if (typeof settings.files === 'string') settings.files = [settings.files];

  if (!_.isArray(settings.files))
    return failure2(new Error('files property takes an array of filenames'));

  if (typeof settings.ignoreAttributes === 'string') settings.ignoreAttributes = [settings.ignoreAttributes];
  else if (!settings.ignoreAttributes) settings.ignoreAttributes = [];

  var streams = _.map(settings.files, function(filename) {
    var fc = fileContent(filename);
    var stream = fs.createReadStream(filename, {
        encoding: settings.fileEncoding || 'utf8'
      })
      .on('error', failure)
      .pipe(through2({
        decodeStrings: false
      }, function(chunk, encoding, callback) {
        callback(null, fc(chunk));
      }));
    return stream;
  });

  var parseSettings = (function(settings) {
    return function(content) {
      return parse(settings, content);
    }
  })(settings);

  var promises = _.map(streams, function(s) {
    return toDataPromise(s, parseSettings);
  });

  var result = Q.all(promises).then(_.flatten);

  if (hasCallback) {
    result.nodeify(callback);
  } else {
    result.then(deferred.resolve, failure);
  }
  return deferred.promise;
};