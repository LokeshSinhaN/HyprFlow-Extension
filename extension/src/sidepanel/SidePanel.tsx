import { useState, useEffect } from 'react';
import { Send, Settings, User, Bot } from 'lucide-react';

interface Message {
  role: 'user' | 'agent';
  content: string;
}

export default function SidePanel() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', content: 'Hello! I am HyperFlow. What would you like to do on this page?' }
  ]);
  const [input, setInput] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(['geminiApiKey'], (result) => {
      if (result.geminiApiKey) {
        setApiKey(result.geminiApiKey);
      } else {
        setShowSettings(true);
      }
    });
  }, []);

  const saveApiKey = () => {
    chrome.storage.local.set({ geminiApiKey: apiKey }, () => {
      setShowSettings(false);
    });
  };

  const handleSend = () => {
    if (!input.trim()) return;
    
    const newMsg: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    
    // In the future, this will send a message to the background script
    // to initiate the multi-agent orchestration.
    chrome.runtime.sendMessage({ type: 'USER_COMMAND', payload: input });
  };

  if (showSettings) {
    return (
      <div className="flex flex-col h-full bg-white p-4">
        <h2 className="text-xl font-bold mb-4">Settings</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Gemini API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full border rounded px-3 py-2"
            placeholder="AIzaSy..."
          />
        </div>
        <button
          onClick={saveApiKey}
          className="bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700"
        >
          Save
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex items-center justify-between bg-white border-b px-4 py-3 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-800">HyperFlow</h1>
        <button onClick={() => setShowSettings(true)} className="text-gray-500 hover:text-gray-700">
          <Settings size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex items-start max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-blue-100 ml-2' : 'bg-green-100 mr-2'}`}>
                {msg.role === 'user' ? <User size={16} className="text-blue-600" /> : <Bot size={16} className="text-green-600" />}
              </div>
              <div className={`p-3 rounded-lg ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white border text-gray-800'}`}>
                {msg.content}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 bg-white border-t">
        <div className="flex items-center border rounded-full px-3 py-2 bg-gray-50">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a command..."
            className="flex-1 bg-transparent outline-none px-2"
          />
          <button onClick={handleSend} className="text-blue-600 p-1 hover:bg-blue-50 rounded-full">
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
