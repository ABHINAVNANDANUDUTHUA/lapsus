import React from 'react';

function App() {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-6 relative overflow-hidden">
      
      {/* Background Decorative Blobs */}
      <div className="absolute top-0 left-0 w-72 h-72 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
      <div className="absolute top-0 right-0 w-72 h-72 bg-yellow-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
      <div className="absolute -bottom-8 left-20 w-72 h-72 bg-pink-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>

      {/* Main Card */}
      <div className="relative z-10 max-w-lg w-full bg-gray-800/50 backdrop-blur-lg border border-gray-700 rounded-2xl shadow-2xl p-10 text-center">
        
        {/* Status Indicator */}
        <div className="flex justify-center mb-8">
          <div className="relative">
            <div className="absolute -inset-1 bg-red-500 rounded-full blur opacity-75 animate-pulse"></div>
            <div className="relative bg-gray-900 rounded-full p-4 border border-gray-700">
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                className="h-10 w-10 text-red-500" 
                fill="none" 
                viewBox="0 0 24 24" 
                stroke="currentColor" 
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          </div>
        </div>

        {/* Text Content */}
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-gray-100 to-gray-400 mb-4">
          Permanently Shutdown
        </h1>
        
        <p className="text-gray-400 text-lg mb-8 leading-relaxed">
          This platform has ceased all operations. We are no longer accepting new users or processing data.
        </p>

        <div className="h-px w-full bg-gradient-to-r from-transparent via-gray-600 to-transparent my-6"></div>

        {/* Footer Info */}
        <div className="space-y-2">
          <p className="text-sm text-gray-500">
            Thank you for being part of our journey.
          </p>
          <p className="text-xs text-gray-600 mt-4">
            &copy; {new Date().getFullYear()} Operations Halted.
          </p>
        </div>

      </div>
    </div>
  );
}

export default App;
