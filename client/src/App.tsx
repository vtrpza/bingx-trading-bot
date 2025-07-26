import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import AssetsPage from './pages/AssetsPage'
import TradingPage from './pages/TradingPage'

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<AssetsPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/trading" element={<TradingPage />} />
      </Routes>
    </Layout>
  )
}

export default App