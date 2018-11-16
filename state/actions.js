const debug = require('debug')('ssb-chat-core:actions')
const Immutable = require('immutable')
const state = require('./')
const events = require('./events')
const storage = require('../util/storage')
const constants = require('../util/constants')

let actions

// #region author actions
const setName = (id) => {
  debug('attempting to set real name for %s', id)
  const sbot = state.get('sbot')
  if (sbot.about && sbot.about.socialValue) {
    let input
    if (Array.isArray(id)) {
      input = id
    } else {
      input = [id]
    }
    let promises = []
    input.forEach((i) => {
      promises.push(new Promise((resolve) => {
        sbot.about.socialValue({ key: 'name', dest: i }, (err, name) => {
          if (err) {
            debug('sbot returned error getting name for %s: %s', id, err.message)
            return resolve()
          }
          state.setIn(['authors', i], name)
          debug('set name for %s in state to %s', i, name)
          return resolve()
        })
      }))
    })
    return Promise.all(promises)
      .then(() => {
        debug('emitting an event because authors have changed')
        events.emit('authors-changed', getAll().toJS())
      })
      .catch((e) => {})
  } else {
    debug('sbot.about.socialValue is undefined, no name can be set for %s', id)
  }
}
const getName = (id) => {
  debug('attempting to get name from state for %s', id)
  const name = state.getIn(['authors', id])
  if (!name || name === id) {
    debug('name not found in state for %s', id)
    // if we don't have a name for the requested id
    // try to get it from sbot (and cache it for later)
    actions.authors.setName(id)
  }
  return name || id
}
const bulkNames = (ids) => {
  const pending = new Set()
  ids.forEach((id) => {
    const name = state.getIn(['authors', id])
    if (!name || name === id) {
      pending.add(id)
    }
  })
  actions.authors.setName([...pending])
}
const getId = (name) => {
  const authorId = state.get('authors')
    .findKey(author => {
      if (name[0] === '@') {
        return author === name.slice(1)
      }
      return author === name
    })
  return authorId || name
}
const findMatches = (partial) => actions.authors.get()
  .filter(name => name && name.startsWith(partial))
  .toArray()
const getAll = () => state.get('authors')
const updateFriends = () => {
  debug('updating friends')
  const me = state.get('me')
  const sbot = state.get('sbot')

  sbot.friends.get({ source: me }, (err, data) => {
    if (err) {
      debug('sbot errored when getting friends: %s', err.message)
      return
    }
    const following = new Set()
    const blocking = new Set()
    Object.keys(data).forEach((id) => {
      if (data[id]) {
        following.add(id)
      } else if (!data[id] && data[id] !== null) {
        blocking.add(id)
      }
    })
    debug('setting state for updated friends/blocks')
    state.set('friends', { following: [...following], blocking: [...blocking] })
    debug('emitting event for friends-changed after update')
    events.emit('friends-changed', state.get('friends').toJS())

    // also grab the names of these contacts for searching later
    actions.authors.bulkNames([...following, ...blocking])
  })
}
const getFriends = () => state.get('friends')
// #endregion

// #region me actions
const getMe = () => state.get('me')
const setMe = (me) => {
  state.set('me', me)
  debug('emitting event me-changed because we set me to %s', me)
  events.emit('me-changed', state.get('me'))

  // also get my names and add them to state
  const sbot = state.get('sbot')
  if (sbot.about && sbot.about.socialValues) {
    sbot.about.socialValues({ key: 'name', dest: me }, (err, names) => {
      if (err) {
        debug('sbot errored looking for my names, %s', err.message)
        state.set('myNames', [])
        debug('emitting empty myNames')
        events.emit('my-names-changed', [])
        return
      }
      const myNamesSet = new Set(Object.values(names)) // remove dupes
      const myNames = [...myNamesSet]
      state.set('myNames', myNames)
      debug('emitting my-names-changed with my names')
      events.emit('my-names-changed', myNames)
    })
  } else {
    debug('sbot.about.socialValues is undefined, cannot get myNames')
  }
}
const names = () => state.get('myNames')
// #endregion

// #region message actions
const addInPlace = (msg) => {
  const messages = state.get('messages')
  // put message in the right place time-wise
  const timestamp = msg.timestamp
  const size = messages.size

  // handle edge case
  if (!size || messages.last().get('timestamp') < timestamp) {
    // this message should just go at the end
    state.set('messages', messages.push(Immutable.fromJS(msg)))
    return
  }

  // find lowest nearest
  for (let i = 0; i < size; i++) {
    if (messages.get(i).get('timestamp') >= timestamp) {
      state.set('messages', messages.insert(i, Immutable.fromJS(msg)))
      return
    }
  }
}

const getMessages = () => state.get('filteredMessages')
const refreshFiltered = () => {
  const messages = state.get('messages')
  if (actions.mode.isPrivate()) {
    // if in private mode, only show messages that are either from
    // the person/people i am in private mode with
    // OR from me that i sent to people i'm in private mode with
    state.set('filteredMessages', messages.filter(msg => {
      return msg.get('private') && actions.recipients.compare(msg.get('recipients'), actions.recipients.get())
    }))
    events.emit('messages-changed', getMessages().toJS())
    return
  }
  state.set('filteredMessages', messages.filter(msg => !msg.get('private')))
  events.emit('messages-changed', getMessages().toJS())
}
const push = (msg) => {
  actions.messages.addInPlace(msg)
  actions.messages.refreshFiltered()
  if (msg.private) {
    const myId = actions.me.get()
    // if we don't already have a root for private messages in this chat,
    // and we're in private mode at this time, we can use this message as the new root
    if (actions.mode.isPrivate() && !state.get('privateMessageRoot')) {
      state.set('privateMessageRoot', msg.key)
    }

    // also if this wasn't sent by us
    if (msg.recipients.size && msg.author !== myId) {
      // see if these recipients are already in an unread notification
      let unreadRecipients = Immutable.Set(msg.recipients).delete(myId)

      const currentUnreads = actions.unreads.get()
      const alreadyNoted = currentUnreads.some(un => actions.recipients.compare(un, unreadRecipients))

      // if we haven't already noted this unread message
      if (!alreadyNoted) {
        // and of course confirm that this message isn't already read
        // based on saved read message keys on disk
        if (!actions.storage.hasThisBeenRead(msg)) {
          // then push to unreads on state
          actions.unreads.add(unreadRecipients.sort())
          actions.recents.add(unreadRecipients.add(myId).sort())
        }
      }
    }
  }
}
// #endregion

// #region mode actions
const getMode = () => state.get('mode')
const setPublic = () => {
  state.set('mode', constants.MODE.PUBLIC)
  actions.recipients.reset()
  actions.messages.refreshFiltered()
  events.emit('mode-changed', constants.MODE.PUBLIC)
}
const setPrivate = () => {
  state.set('mode', constants.MODE.PRIVATE)

  // refresh our filtered messages to be only private
  actions.messages.refreshFiltered()

  // we want to get the message id of the latest message
  // in this private thread, and use that as the root for future messages
  // but if there is no 'latest message' in this thread, we'll
  // set the root after first message sent
  const lastMessage = actions.messages.get().last()
  if (lastMessage) {
    state.set('privateMessageRoot', lastMessage.get('key'))
  }

  // fire the mode change hook
  events.emit('mode-changed', constants.MODE.PRIVATE)
}
const isPrivate = () => {
  return state.get('mode') === constants.MODE.PRIVATE
}
// #endregion

// #region recipient actions
const resetPrivateRecipients = () => {
  const pr = getPrivateRecipients()
  if (pr.size) {
    state.set('lastPrivateRecipients', getPrivateRecipients())
    events.emit('last-recipients-changed', state.get('lastPrivateRecipients').toJS())
  }
  state.set('privateRecipients', Immutable.Set())
  state.set('privateMessageRoot', '')
  events.emit('recipients-changed', state.get('privateRecipients').toJS())
}
const compare = (a, b) => {
  if (!Immutable.Set.isSet(a) || !Immutable.Set.isSet(b)) {
    return false
  }
  if (a.size !== b.size) {
    return false
  }
  for (var x of a) {
    if (!b.has(x)) {
      return false
    }
  }
  return true
}

const getPrivateRecipients = () => state.get('privateRecipients')
const setPrivateRecipients = (recipients) => {
  const privateRecipients = Immutable.Set(recipients).add(actions.me.get()).sort()

  state.set('privateRecipients', privateRecipients)

  // add these recipients to recents storage
  actions.recents.add(privateRecipients)

  actions.mode.setPrivate()
  actions.unreads.setAsRead(privateRecipients)
  events.emit('recipients-changed', state.get('privateRecipients').toJS())
}
const getNotMe = () => getPrivateRecipients()
  .filter(r => r !== actions.me.get())
  .map(actions.authors.getName)
const getPrivateRoot = () => state.get('privateMessageRoot')
const getLast = () => state.get('lastPrivateRecipients')
// #endregion

// #region sbot actions
const getSbot = () => state.get('sbot')
const setSbot = (sbot) => state.set('sbot', sbot)
// #endregion

// #region unread actions
const addUnread = (recipients) => {
  const currentUnreads = actions.unreads.get()
  state.set('unreads', currentUnreads.push(recipients))
  events.emit('unreads-changed', state.get('unreads').toJS())
}
const getUnreads = () => state.get('unreads')
const getLastUnread = () => getUnreads().last()
const setAsRead = (recps) => {
  // when we create an unread, we leave off our own username
  // so to clear an unread we need to take our own username off the criteria
  const filteredRecps = recps.filter(r => r !== actions.me.get())
  const newUnreads = getUnreads().filter((unreadRecps) => (
    !actions.recipients.compare(filteredRecps, unreadRecps)
  ))
  state.set('unreads', newUnreads)
  events.emit('unreads-changed', state.get('unreads').toJS())

  // mark all messages in the current conversation as read
  actions.storage.markFilteredMessagesRead()
}
// #endregion

// #region options actions
const getOptions = () => state.get('options')
const setOptions = (opts) => {
  Object.keys(opts).forEach(key => {
    actions.options.set(key, opts[key])
  })
}
const setOption = (key, val) => {
  state.setIn(['options', key], val)
  events.emit('options-changed', state.get('options').toJS())
}
// #endregion

// #region storage actions
const storeAsRead = (message) => {
  const timeWindow = actions.options.get().get('timeWindow')
  const ttl = (message.get('timestamp') + timeWindow) - Date.now()
  storage.readStorage.setItemSync(message.get('key'), true, { ttl })
}
const markFilteredMessagesRead = () => {
  const filteredMessages = actions.messages.get()
  filteredMessages.forEach(msg => actions.storage.storeAsRead(msg))
}
const hasThisBeenRead = (message) => storage.readStorage.getItemSync(message.key)
// #endregion

// #region recent actions
const getRecents = () => {
  const recents = storage.recentStorage.keys()
  return recents.map(r => r.split(','))
}
const addRecent = (recipients) => {
  const key = recipients.toArray().join(',')
  storage.recentStorage.setItemSync(key, true)
  events.emit('recents-changed', actions.recents.get()) // recents is not Immutable
}
const removeRecent = (recipients) => {
  const key = recipients.join(',')
  storage.recentStorage.removeItemSync(key)
  events.emit('recents-changed', actions.recents.get())
}
// #endregion

// #region progress actions
const setProgress = (progress) => {
  state.set('progress', progress)
  events.emit('progress-changed', state.get('progress').toJS())
}
const getProgress = () => state.get('progress')
// #endregion

actions = module.exports = {
  authors: {
    bulkNames,
    get: getAll,
    getJS: () => getAll().toJS(),
    setName,
    getName,
    getId,
    findMatches,
    updateFriends,
    getFriends,
    getFriendsJS: () => getFriends().toJS()
  },
  me: {
    get: getMe,
    set: setMe,
    names,
    namesJS: () => names().toJS()
  },
  messages: {
    addInPlace,
    get: getMessages,
    getJS: () => getMessages().toJS(),
    push,
    refreshFiltered
  },
  mode: {
    get: getMode,
    isPrivate,
    setPrivate,
    setPublic
  },
  recipients: {
    get: getPrivateRecipients,
    getJS: () => getPrivateRecipients().toJS(),
    reset: resetPrivateRecipients,
    set: setPrivateRecipients,
    getNotMe,
    compare,
    getPrivateRoot,
    getLast
  },
  sbot: {
    get: getSbot,
    set: setSbot
  },
  unreads: {
    add: addUnread,
    get: getUnreads,
    getJS: () => getUnreads().toJS(),
    getLast: getLastUnread,
    setAsRead
  },
  options: {
    get: getOptions,
    getJS: () => getOptions().toJS(),
    set: setOption,
    setOptions
  },
  storage: {
    storeAsRead,
    markFilteredMessagesRead,
    hasThisBeenRead
  },
  recents: {
    get: getRecents,
    add: addRecent,
    remove: removeRecent
  },
  progress: {
    set: setProgress,
    get: getProgress,
    getJS: () => getProgress().toJS()
  }
}
