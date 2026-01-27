// Axios instance with CORS-friendly configuration
import axios from 'axios';
import { apiConfig } from './config';

const apiClient = axios.create({
    baseURL: apiConfig.baseURL,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

// Request interceptor
apiClient.interceptors.request.use(
    (config) => {
        console.log(📤 API Request: ${config.method.toUpperCase()} ${config.url});
        return config;
    },
    (error) => {
        console.error('❌ Request Error:', error);
        return Promise.reject(error);
    }
);

// Response interceptor
apiClient.interceptors.response.use(
    (response) => {
        console.log(✅ API Response: ${response.status} ${response.statusText});
        return response;
    },
    (error) => {
        console.error('❌ Response Error:', error);
        if (error.response) {
            console.error(Status: ${error.response.status});
            console.error(Data:, error.response.data);
        } else if (error.request) {
            console.error('No response received:', error.request);
        } else {
            console.error('Error:', error.message);
        }
        return Promise.reject(error);
    }
);

export default apiClient;
