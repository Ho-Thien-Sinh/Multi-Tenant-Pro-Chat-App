import { useState, useEffect } from 'react'
import { io, Socket } from 'socket.io-client'

interface User {
  id: string
  email: string
  username: string
  tenant_id: string
}

interface Room {
  id: string
  name: string
  type: 'direct' | 'group'
  description?: string
}

interface Message {
  id: string
  room_id: string
  user_id: string
  content: string
  created_at: string
  reply_to_message_id?: string
}

interface TypingUser {
  userId: string
  roomId: string
}

function App() {
  const [view, setView] = useState<'login' | 'register' | 'forgot-password' | 'chat'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  
  // Chat state
  const [rooms, setRooms] = useState<Room[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [messageInput, setMessageInput] = useState('')
  const [socket, setSocket] = useState<Socket | null>(null)
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])
  const [isTyping, setIsTyping] = useState(false)

  // New states for search and group creation
  const [searchQuery, setSearchQuery] = useState('')
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])

  useEffect(() => {
    const savedToken = localStorage.getItem('token')
    const savedUser = localStorage.getItem('user')
    if (savedToken && savedUser) {
      setToken(savedToken)
      setCurrentUser(JSON.parse(savedUser))
      setView('chat')
    }
  }, [])

  useEffect(() => {
    if (token) {
      fetchRooms()
      fetchUsers()
      connectSocket()
    }
    return () => {
      if (socket) socket.disconnect()
    }
  }, [token])

  useEffect(() => {
    if (selectedRoom && socket) {
      socket.emit('join-room', {
        roomId: selectedRoom.id,
        userId: currentUser?.id,
        tenantId: currentUser?.tenant_id
      })
      fetchMessages(selectedRoom.id)
    }
  }, [selectedRoom, socket, currentUser])

  const connectSocket = () => {
    if (!token) return
    
    const newSocket = io('http://localhost:3000', {
      auth: { token }
    })
    setSocket(newSocket)

    newSocket.on('user-online', (data: { userId: string }) => {
      console.log('User online:', data.userId)
    })
  }

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg: Message) => {
      if (msg.room_id === selectedRoom?.id) {
        setMessages((prev) => {
          if (prev.find(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    };

    const handleTypingStart = (data: TypingUser) => {
      if (data.roomId === selectedRoom?.id) {
        setTypingUsers((prev) => {
          if (prev.find(u => u.userId === data.userId)) return prev;
          return [...prev, data];
        });
      }
    };

    const handleTypingStop = (data: TypingUser) => {
      setTypingUsers((prev) => prev.filter(u => u.userId !== data.userId));
    };

    socket.on('newMessage', handleNewMessage);
    socket.on('user-typing', handleTypingStart);
    socket.on('user-stop-typing', handleTypingStop);

    return () => {
      socket.off('newMessage', handleNewMessage);
      socket.off('user-typing', handleTypingStart);
      socket.off('user-stop-typing', handleTypingStop);
    };
  }, [socket, selectedRoom]);

  const login = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await response.json()
      if (data.status === 'success') {
        setToken(data.data.token)
        setCurrentUser(data.data.user)
        localStorage.setItem('token', data.data.token)
        localStorage.setItem('user', JSON.stringify(data.data.user))
        setView('chat')
      } else {
        alert(data.message || 'Đăng nhập thất bại')
      }
    } catch (error) {
      console.error('Login error:', error)
      alert('Lỗi kết nối')
    }
  }

  const register = async () => {
    if (!username || !email || !password || !confirmPassword) {
      alert('Vui lòng điền tất cả các trường')
      return
    }
    if (password !== confirmPassword) {
      alert('Mật khẩu không khớp')
      return
    }
    try {
      const response = await fetch('http://localhost:3000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password })
      })
      const data = await response.json()
      if (data.status === 'success') {
        alert('Đăng ký thành công! Vui lòng đăng nhập.')
        setView('login')
        setUsername('')
        setEmail('')
        setPassword('')
        setConfirmPassword('')
      } else {
        alert(data.message || 'Đăng ký thất bại')
      }
    } catch (error) {
      console.error('Register error:', error)
      alert('Lỗi kết nối')
    }
  }

  const forgotPassword = async () => {
    if (!email) {
      alert('Vui lòng nhập email')
      return
    }
    try {
      const response = await fetch('http://localhost:3000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      const data = await response.json()
      if (data.status === 'success') {
        alert(data.message)
        setView('login')
      }
    } catch (error) {
      console.error('Forgot password error:', error)
      alert('Lỗi kết nối')
    }
  }

  const logout = async () => {
    try {
      await fetch('http://localhost:3000/api/auth/logout', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ refreshToken: localStorage.getItem('refreshToken') })
      })
    } catch (error) {
      console.error('Logout error:', error)
    }
    setToken(null)
    setCurrentUser(null)
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setView('login')
    if (socket) socket.disconnect()
  }

  const fetchRooms = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/rooms', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()
      if (data.status === 'success') {
        setRooms(data.data)
      }
    } catch (error) {
      console.error('Error fetching rooms:', error)
    }
  }

  const fetchUsers = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/users', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()
      if (data.status === 'success') {
        setUsers(data.data)
      }
    } catch (error) {
      console.error('Error fetching users:', error)
    }
  }

  const fetchMessages = async (roomId: string) => {
    try {
      const response = await fetch(`http://localhost:3000/api/rooms/${roomId}/messages`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await response.json()
      if (data.status === 'success') {
        setMessages(data.data.messages || [])
      }
    } catch (error) {
      console.error('Error fetching messages:', error)
    }
  }

  const createDirectConversation = async (targetUserId: string) => {
    try {
      const response = await fetch('http://localhost:3000/api/conversations/direct', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ userId: targetUserId })
      })
      const data = await response.json()
      if (data.status === 'success') {
        setSelectedRoom(data.data)
        fetchRooms()
      }
    } catch (error) {
      console.error('Error creating conversation:', error)
    }
  }

  const createGroup = async () => {
    if (!groupName.trim() || selectedMembers.length < 2) {
      alert('Vui lòng nhập tên nhóm và chọn ít nhất 2 thành viên khác');
      return;
    }
    
    try {
      const response = await fetch('http://localhost:3000/api/groups', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          name: groupName,
          description: groupDescription,
          memberIds: [...selectedMembers, currentUser?.id]
        })
      })
      const data = await response.json()
      if (data.status === 'success') {
        setSelectedRoom(data.data)
        fetchRooms()
        setShowGroupModal(false)
        setGroupName('')
        setGroupDescription('')
        setSelectedMembers([])
      } else {
        alert(data.message || 'Tạo nhóm thất bại')
      }
    } catch (error) {
      console.error('Error creating group:', error)
      alert('Lỗi kết nối')
    }
  }

  const sendMessage = async () => {
    if (!selectedRoom || !messageInput.trim() || !token) return
    
    try {
      const response = await fetch(`http://localhost:3000/api/rooms/${selectedRoom.id}/messages`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          content: messageInput,
          clientMessageId: `${Date.now()}-${currentUser?.id}`
        })
      })
      const data = await response.json()
      if (data.status === 'success') {
        setMessages((prev) => {
          if (prev.find(m => m.id === data.data.id)) return prev;
          return [...prev, data.data];
        })
        setMessageInput('')
      }
    } catch (error) {
      console.error('Error sending message:', error)
    }
  }

  const handleTypingStart = () => {
    if (!socket || !selectedRoom || isTyping) return
    setIsTyping(true)
    socket.emit('typing-start', {
      roomId: selectedRoom.id,
      userId: currentUser?.id,
      tenantId: currentUser?.tenant_id
    })
  }

  const handleTypingStop = () => {
    if (!socket || !selectedRoom) return
    setIsTyping(false)
    socket.emit('typing-stop', {
      roomId: selectedRoom.id,
      userId: currentUser?.id,
      tenantId: currentUser?.tenant_id
    })
  }

  if (view === 'login') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold text-center mb-8 text-gray-800">Chat App</h1>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 pr-12"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </div>
            <button
              onClick={login}
              className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition font-semibold"
            >
              Đăng nhập
            </button>
            <div className="flex justify-between text-sm">
              <button
                onClick={() => setView('register')}
                className="text-blue-500 hover:text-blue-600"
              >
                Đăng ký tài khoản mới
              </button>
              <button
                onClick={() => setView('forgot-password')}
                className="text-blue-500 hover:text-blue-600"
              >
                Quên mật khẩu?
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'register') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold text-center mb-8 text-gray-800">Đăng ký</h1>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="username"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 pr-12"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Confirm Password</label>
              <div className="relative">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 pr-12"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showConfirmPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </div>
            <button
              onClick={register}
              className="w-full py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 transition font-semibold"
            >
              Đăng ký
            </button>
            <div className="text-center text-sm">
              <button
                onClick={() => setView('login')}
                className="text-blue-500 hover:text-blue-600"
              >
                Quay lại đăng nhập
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'forgot-password') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold text-center mb-8 text-gray-800">Quên mật khẩu</h1>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="your@email.com"
              />
            </div>
            <button
              onClick={forgotPassword}
              className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition font-semibold"
            >
              Gửi email reset mật khẩu
            </button>
            <div className="text-center text-sm">
              <button
                onClick={() => setView('login')}
                className="text-blue-500 hover:text-blue-600"
              >
                Quay lại đăng nhập
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const getRoomDisplayName = (room: Room) => {
    if (room.type === 'direct') {
      const parts = room.name.split('_');
      if (parts.length === 3) {
        const otherId = parts[1] === currentUser?.id ? parts[2] : parts[1];
        const otherUser = users.find(u => u.id === otherId);
        if (otherUser) return otherUser.username;
      }
    }
    return room.name;
  };

  return (
    <div className="min-h-screen bg-gray-100 flex">
      {/* Sidebar */}
      <div className="w-80 bg-white border-r flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h1 className="text-xl font-bold">Chat App</h1>
          <button onClick={logout} className="text-sm text-red-500 hover:text-red-600">
            Đăng xuất
          </button>
        </div>
        
        {/* Users List */}
        <div className="p-4 border-b">
          <h2 className="text-sm font-semibold text-gray-600 mb-3">Người dùng</h2>
          <div className="mb-3">
            <input
              type="text"
              placeholder="Tìm kiếm..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {users
              .filter(user => 
                user.id !== currentUser?.id && 
                (user.username.toLowerCase().includes(searchQuery.toLowerCase()) || 
                 user.email.toLowerCase().includes(searchQuery.toLowerCase()))
              )
              .map((user) => (
                <div
                  key={user.id}
                  onClick={() => createDirectConversation(user.id)}
                  className="p-2 hover:bg-gray-100 rounded-lg cursor-pointer flex items-center gap-2"
                >
                  <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-semibold">
                    {user.username[0].toUpperCase()}
                  </div>
                  <span className="text-sm">{user.username}</span>
                </div>
            ))}
          </div>
        </div>

        {/* Rooms List */}
        <div className="flex-1 p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-600">Cuộc trò chuyện</h2>
            <button 
              onClick={() => setShowGroupModal(true)}
              className="text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded hover:bg-blue-200 transition"
              title="Tạo nhóm mới"
            >
              + Tạo nhóm
            </button>
          </div>
          <div className="space-y-2">
            {rooms.map((room) => (
              <div
                key={room.id}
                onClick={() => setSelectedRoom(room)}
                className={`p-3 rounded-lg cursor-pointer ${
                  selectedRoom?.id === room.id ? 'bg-blue-500 text-white' : 'hover:bg-gray-100'
                }`}
              >
                <div className="font-semibold">{getRoomDisplayName(room)}</div>
                <div className="text-xs opacity-75">{room.type === 'direct' ? 'Direct' : 'Group'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedRoom ? (
          <>
            {/* Chat Header */}
            <div className="p-4 bg-white border-b flex items-center justify-between">
              <div>
                <h2 className="font-semibold">{getRoomDisplayName(selectedRoom)}</h2>
                <p className="text-sm text-gray-500">{selectedRoom.type === 'direct' ? 'Direct chat' : 'Group chat'}</p>
              </div>
              {typingUsers.length > 0 && (
                <div className="text-sm text-gray-500">
                  {typingUsers.map(u => u.userId).join(', ')} đang nhập...
                </div>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
              <div className="space-y-4">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.user_id === currentUser?.id ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                        msg.user_id === currentUser?.id
                          ? 'bg-blue-500 text-white'
                          : 'bg-white border'
                      }`}
                    >
                      {msg.user_id !== currentUser?.id && (
                        <div className="text-xs font-semibold mb-1 text-blue-500">
                          {users.find(u => u.id === msg.user_id)?.username || 'Unknown'}
                        </div>
                      )}
                      <div>{msg.content}</div>
                      <div className="text-xs mt-1 opacity-75">
                        {new Date(msg.created_at).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Message Input */}
            <div className="p-4 bg-white border-t">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onFocus={handleTypingStart}
                  onBlur={handleTypingStop}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Nhập tin nhắn..."
                />
                <button
                  onClick={sendMessage}
                  className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition"
                >
                  Gửi
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Chọn một cuộc trò chuyện để bắt đầu
          </div>
        )}
      </div>

      {/* Group Creation Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md">
            <h2 className="text-2xl font-bold mb-4">Tạo nhóm chat</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tên nhóm</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Nhập tên nhóm..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mô tả (tuỳ chọn)</label>
                <input
                  type="text"
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Nhập mô tả..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Chọn thành viên</label>
                <div className="max-h-48 overflow-y-auto border rounded-lg p-2 space-y-1">
                  {users.filter(u => u.id !== currentUser?.id).map(user => (
                    <label key={user.id} className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={selectedMembers.includes(user.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedMembers(prev => [...prev, user.id]);
                          } else {
                            setSelectedMembers(prev => prev.filter(id => id !== user.id));
                          }
                        }}
                        className="rounded text-blue-500 focus:ring-blue-500"
                      />
                      <span className="text-sm">{user.username} ({user.email})</span>
                    </label>
                  ))}
                  {users.length <= 1 && (
                    <p className="text-sm text-gray-500 italic p-2">Chưa có người dùng nào khác để mời.</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 justify-end mt-6">
                <button
                  onClick={() => setShowGroupModal(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition"
                >
                  Huỷ
                </button>
                <button
                  onClick={createGroup}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition font-semibold"
                >
                  Tạo nhóm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
