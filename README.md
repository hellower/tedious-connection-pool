# tedious-connection-pool

A connection pool for [tedious](http://github.com/tediousjs/tedious).

## Installation

    npm install mhingston/tedious-connection-pool
    
## Description
The API is almost identical to the official [tedious-connection-pool](https://github.com/tediousjs/tedious-connection-pool). Rather than creating a connection and then closing it when finished, you acquire a connection from the pool and release it when finished.

Once the Tedious Connection object has been acquired, the tedious API can be used with the connection as normal.

## Example (callback)

```javascript
var ConnectionPool = require('tedious-connection-pool');
var Request = require('tedious').Request;

var poolConfig = {
    min: 2,
    max: 4,
    idleTimeout: 60000,
    log: true
};

var connectionConfig = {
    server: 'localhost'
    "options": {
      "encrypt": false,
      "port": 1433,
      "database": "model"
    },
    "authentication": {
      "type": "default",
      "options": {
        "userName": "sa",
        "password": "xxxx"
      }
    }    
};

//create the pool
var pool = new ConnectionPool(poolConfig, connectionConfig);

//acquire a connection
pool.acquire(function (error, connection) {
    if (error) {
        console.error(error);
        return;
    }

    //use the connection as normal
    var request = new Request('select 42', function(error, rowCount) {
        if (error) {
            console.error(error);
            return;
        }

        console.log('rowCount: ' + rowCount);

        //release the connection back to the pool when finished
        connection.release();
    });

    request.on('row', function(columns) {
        console.log('value: ' + columns[0].value);
    });

    connection.execSql(request);
});
```

## Example (promise)

```javascript
var ConnectionPool = require('tedious-connection-pool');
var Request = require('tedious').Request;

var poolConfig = {
    min: 2,
    max: 4,
    log: true
};

var connectionConfig = {
    userName: 'login',
    password: 'password',
    server: 'localhost'
};

//create the pool
var pool = new ConnectionPool(poolConfig, connectionConfig);

//acquire a connection
pool.acquire()
.then(function (connection) {
    //use the connection as normal
    var request = new Request('select 42', function(error, rowCount) {
        if (error) {
            console.error(error);
            return;
        }

        console.log('rowCount: ' + rowCount);

        //release the connection back to the pool when finished
        connection.release();
    });

    request.on('row', function(columns) {
        console.log('value: ' + columns[0].value);
    });

    connection.execSql(request);
})
.catch(function (error) {
    console.error(error);
});
```

When you are finished with the pool, you can drain it (close all connections).
```javascript
pool.drain();
```


## Class: ConnectionPool

### new ConnectionPool(poolConfig, connectionConfig)

* `poolConfig` {Object} the pool configuration object
  * `min` {Number} The minimun of connections there can be in the pool. Default = `10`
  * `max` {Number} The maximum number of connections there can be in the pool. Default = `50`
  * `idleTimeout` {Number} The number of milliseconds before closing an unused connection. Default = `30000`
  * `acquireTimeout` {Number} The number of milliseconds to wait for a connection, before returning an error. Default = `60000`
  * `log` {Boolean|Function} Set to true to have debug log written to the console or pass a function to receive the log messages. Default = `false`
  
* `connectionConfig` {Object} The same configuration that would be used to [create a
  tedious Connection](https://tediousjs.github.io/tedious/api-connection.html#function_newConnection).

### connectionPool.acquire(callback)
Acquire a Tedious Connection object from the pool. This method returns a promise, but you can use a callback function if you prefer.

 * `callback(error, connection)` {Function} Callback function
  * `error` {Object} Object containing an error that occurred whilst trying to acquire a connection, otherwise null.
  * `connection` {Object} A [Connection](https://tediousjs.github.io/tedious/api-connection.html)

### connectionPool.drain()
Close all pooled connections and stop making new ones. The pool should be discarded after it has been drained.

## Class: Connection
The following method is added to the Tedious [Connection](https://tediousjs.github.io/tedious/api-connection.html) object.

### Connection.release()
Release the connection back into the pool to be used again.
