import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, Keyboard, FlatList, ActivityIndicator, SafeAreaView, StatusBar, Animated, PanResponder, Dimensions } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';
import { ArrowLeft, TrainFront, Footprints, Navigation, Info } from 'lucide-react-native';
 
const API_BASE_URL = 'http://localhost:5001/api';
const { height: SCREEN_HEIGHT } = Dimensions.get('window');
 
const SHEET_MAX_HEIGHT = SCREEN_HEIGHT * 0.8;
const SHEET_MIN_HEIGHT = SCREEN_HEIGHT * 0.25;
 
export default function App() {
  const mapRef = useRef<MapView>(null);
  
  const speechQueue = useRef<string[]>([]);
  const isSpeaking = useRef(false);
  const lastSpokenRef = useRef<string>("");
  
  const [screen, setScreen] = useState<'search' | 'live'>('search');
  const [stations, setStations] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [walkingSpeed, setWalkingSpeed] = useState('slow');
  
  const [allRoutes, setAllRoutes] = useState<any[]>([]);
  const [activeRoute, setActiveRoute] = useState<any>(null);
  const [liveConfidence, setLiveConfidence] = useState<string>('high');
  const [transferUpdate, setTransferUpdate] = useState<string>('');
  
  const [isRerouting, setIsRerouting] = useState(false);
  const [alternatives, setAlternatives] = useState<any[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);
 
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<any>(null);
  
  const panY = useRef(new Animated.Value(0)).current;
  const [isSheetExpanded, setIsSheetExpanded] = useState(true);
 
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 10,
      onPanResponderMove: (_, gestureState) => {
        const newVal = isSheetExpanded ? gestureState.dy : gestureState.dy + (SHEET_MAX_HEIGHT - SHEET_MIN_HEIGHT);
        if (newVal >= 0 && newVal <= (SHEET_MAX_HEIGHT - SHEET_MIN_HEIGHT)) panY.setValue(newVal);
      },
      onPanResponderRelease: (_, gestureState) => {
        const dragDistance = isSheetExpanded ? gestureState.dy : gestureState.dy + (SHEET_MAX_HEIGHT - SHEET_MIN_HEIGHT);
        if (dragDistance > 100) snapToPosition('collapsed');
        else if (dragDistance < (SHEET_MAX_HEIGHT - SHEET_MIN_HEIGHT) - 100) snapToPosition('expanded');
        else snapToPosition(isSheetExpanded ? 'expanded' : 'collapsed');
      }
    })
  ).current;
 
  const snapToPosition = (to: 'expanded' | 'collapsed') => {
      setIsSheetExpanded(to === 'expanded');
      Animated.spring(panY, {
          toValue: to === 'expanded' ? 0 : (SHEET_MAX_HEIGHT - SHEET_MIN_HEIGHT),
          useNativeDriver: false,
          bounciness: 4
      }).start();
  };
 
  useEffect(() => {
    async function configureAudio() {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch (e) {}
    }
    configureAudio();
 
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/mbta/stations`);
        const data = await res.json();
        if (data.success) setStations(data.data);
      } catch (err) {}
 
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
             await Location.watchPositionAsync(
                 { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 5 },
                 (loc) => {
                     setUserLocation(loc.coords);
                 }
             );
        }
      } catch (e) { setUserLocation({ latitude: 42.355, longitude: -71.065 }); }
    })();
  }, []);
 
  const speak = (message: string) => {
      if (message === lastSpokenRef.current) return;
      lastSpokenRef.current = message;
      speechQueue.current.push(message);
      processSpeechQueue();
  };
 
  const processSpeechQueue = async () => {
      if (isSpeaking.current || speechQueue.current.length === 0) return;
 
      isSpeaking.current = true;
      const nextMessage = speechQueue.current.shift();
      
      try {
          const url = `${API_BASE_URL}/speak?text=${encodeURIComponent(nextMessage || "")}`;
          const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: true });
          
          await new Promise((resolve) => {
              sound.setOnPlaybackStatusUpdate((status) => {
                  if (status.isLoaded && status.didJustFinish) {
                      resolve(true);
                  }
              });
          });
          
      } catch (err) {
          console.log("Audio Error", err);
      } finally {
          isSpeaking.current = false;
          processSpeechQueue();
      }
  };
 
  const recenterMap = () => {
      if (userLocation && mapRef.current) {
          mapRef.current.animateToRegion({
              latitude: userLocation.latitude,
              longitude: userLocation.longitude,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01
          }, 1000);
      }
  };
 
  useEffect(() => {
    if (screen !== 'live' || !activeRoute) return;
 
    const summary = activeRoute.summary || "";
    const linesToTrack: string[] = [];
    if (summary.includes('Red')) linesToTrack.push('Red');
    if (summary.includes('Orange')) linesToTrack.push('Orange');
    if (summary.includes('Blue')) linesToTrack.push('Blue');
    if (summary.includes('Green')) linesToTrack.push('Green-B,Green-C,Green-D,Green-E');
 
    const fetchVehicles = async () => {
        if(linesToTrack.length === 0) return;
        try {
            const res = await fetch(`${API_BASE_URL}/mbta/vehicles?routes=${linesToTrack.join(',')}`);
            const data = await res.json();
            if (data.success) setVehicles(data.data);
        } catch (err) {}
    };
 
    const checkTransferSafety = async () => {
        let newConfidence = activeRoute.catch_confidence;
        let newUpdate = "On Schedule";
 
        for (let i = 0; i < activeRoute.steps.length; i++) {
            const step = activeRoute.steps[i];
            if (step.is_transit && step.stop_id) {
                try {
                    const res = await fetch(`${API_BASE_URL}/mbta/predictions/${step.stop_id}`);
                    const data = await res.json();
                    if (data.success && data.data.length > 0) {
                        const predictions = data.data;
                        const scheduledTime = step.departure_time * 1000;
                        const now = new Date().getTime();
                        let targetTrain = null;
                        let minDiff = Infinity;
                        const scheduledMinutesAway = (scheduledTime - now) / 60000;
 
                        for(let pred of predictions) {
                            const diff = Math.abs(pred.minutes - scheduledMinutesAway);
                            if (diff < 15 && diff < minDiff) { minDiff = diff; targetTrain = pred; }
                        }
 
                        if (targetTrain) {
                            const minutesAway = targetTrain.minutes;
                            let buffer = minutesAway;
                            
                            if (i > 0 && activeRoute.steps[i-1].is_transit) {
                                const prevArrival = activeRoute.steps[i-1].arrival_time * 1000;
                                const minutesUntilArrival = (prevArrival - now) / 60000;
                                buffer = minutesAway - minutesUntilArrival;
                            } else {
                                const walkTimeStr = activeRoute.walk_minutes || "0";
                                const walkMinutes = parseInt(walkTimeStr.split(' ')[0]) || 0;
                                buffer = minutesAway - walkMinutes;
                            }
 
                            if (buffer < 1) {
                                newConfidence = 'low';
                                newUpdate = `Connection Missed`;
                                speak("Note: The connection has likely been missed. Please find a safe place to stop and check for alternative routes.");
                            } else if (buffer < 5) {
                                newConfidence = 'medium';
                                newUpdate = `Tight Connection (${Math.floor(buffer)} min)`;
                                speak(`Advisory: Your train departs in ${Math.floor(minutesAway)} minutes. Please proceed directly to the platform.`);
                            } else {
                                newUpdate = `On Time: ${Math.floor(buffer)} min spare`;
                                if(liveConfidence !== 'high') {
                                    speak("Update: You are on schedule. Proceed at a comfortable pace.");
                                }
                            }
                        }
                    }
                } catch (e) { }
            }
            if (newConfidence === 'low') break;
        }
        setLiveConfidence(newConfidence);
        setTransferUpdate(newUpdate);
    };
 
    fetchVehicles();
    checkTransferSafety();
    const interval = setInterval(() => { fetchVehicles(); checkTransferSafety(); }, 10000);
    return () => clearInterval(interval);
  }, [screen, activeRoute, liveConfidence]);
 
  const getSegmentStyle = (step: any) => {
      if (!step.is_transit || step.mode === 'walking') return { color: '#6B7280', dash: [10, 8], width: 4 };
      const name = (step.line_name || "").toLowerCase();
      if (name.includes('red')) return { color: '#DA291C', dash: undefined, width: 6 };
      if (name.includes('orange')) return { color: '#ED8B00', dash: undefined, width: 6 };
      if (name.includes('blue')) return { color: '#003DA5', dash: undefined, width: 6 };
      if (name.includes('green')) return { color: '#00843D', dash: undefined, width: 6 };
      return { color: '#2563EB', dash: undefined, width: 6 };
  };
 
  const handleReroute = async () => {
      if (!userLocation) { alert("Need location access."); return; }
      setIsRerouting(true);
      try {
          const res = await fetch(`${API_BASE_URL}/directions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: { lat: userLocation.latitude, lng: userLocation.longitude }, destination: destination, walking_speed: walkingSpeed })
          });
          const data = await res.json();
          if (data.success) {
              setAlternatives(data.data);
              setShowAlternatives(true);
              speak(`Found ${data.data.length} alternative routes.`);
          } else { alert("No alternatives found."); }
      } catch (err) { alert("Error finding routes"); }
      setIsRerouting(false);
  };
 
  const selectAlternative = (newRoute: any) => {
      startLiveNavigation(newRoute);
      setShowAlternatives(false);
      setAlternatives([]);
  };
 
  const handleSearch = async () => {
    Keyboard.dismiss();
    if (!origin || !destination) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/directions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, walking_speed: walkingSpeed })
      });
      const data = await res.json();
      if (data.success) {
          setAllRoutes(data.data);
          if (data.data[0]?.path) fitToRoute(data.data[0].path);
      } else { alert("No route found"); }
    } catch (err) { alert("Error connecting to server"); }
    setLoading(false);
  };
 
  const fitToRoute = (path: any[]) => {
    if(!path || path.length === 0) return;
    const coords = path.map((c: any) => ({ latitude: c.lat, longitude: c.lng }));
    mapRef.current?.fitToCoordinates(coords, { edgePadding: { top: 100, right: 40, bottom: 400, left: 40 } });
  }
 
  const startLiveNavigation = (route: any) => {
      setActiveRoute(route);
      setLiveConfidence(route.catch_confidence);
      setScreen('live');
      fitToRoute(route.path);
      
      let script = `Starting navigation to ${destination}. `;
      route.steps.forEach((step: any, index: number) => {
          const instruction = step.instruction.replace(/<[^>]*>?/gm, '');
          if (index === 0 && !step.is_transit) {
              script += `First, ${instruction}. `;
          } else if (step.is_transit) {
              script += `Then, ${instruction}. `;
              // 🆕 ADD ACCESSIBILITY TO VOICE
              if (step.accessibility_info) {
                  script += `This station has ${step.accessibility_info}. `;
              }
          }
      });
      script += `Route status is ${route.catch_confidence === 'high' ? 'comfortable' : 'tight'}.`;
      speak(script);
  };
 
  const exitLiveNavigation = () => {
      setScreen('search');
      setActiveRoute(null);
      setVehicles([]);
      lastSpokenRef.current = "";
      snapToPosition('expanded');
      setShowAlternatives(false);
  };
 
  const getConfidenceColor = (conf: string) => {
      if (conf === 'high') return '#10B981';
      if (conf === 'medium') return '#F59E0B';
      return '#EF4444';
  };
 
  const formatTime = (ts: number) => {
      if(!ts) return "";
      return new Date(ts * 1000).toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
  };
 
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{latitude: 42.3601, longitude: -71.0589, latitudeDelta: 0.05, longitudeDelta: 0.05}}
        showsUserLocation={true}
        followsUserLocation={screen === 'live' && !isSheetExpanded}
      >
        {screen === 'search' && stations.map(s => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title={s.name}
            pinColor={s.routes[0].includes('Red') ? '#DA291C' : s.routes[0].includes('Orange') ? '#ED8B00' : '#00843D'} />
        ))}
        
        {/* NO EMOJI BADGES - Just train markers */}
        {screen === 'live' && vehicles.map(v => (
            <Marker key={v.id} coordinate={{ latitude: v.lat, longitude: v.lng }} rotation={v.bearing} anchor={{x:0.5, y:0.5}}>
                <View style={[styles.trainMarker, { backgroundColor: v.route.includes('Red') ? '#DA291C' : v.route.includes('Orange') ? '#ED8B00' : v.route.includes('Blue') ? '#003DA5' : '#00843D' }]}>
                    <TrainFront size={12} color="white"/>
                </View>
            </Marker>
        ))}
        
        {(screen === 'live' && activeRoute) && activeRoute.steps.map((step: any, index: number) => {
            const style = getSegmentStyle(step);
            if (!step.path || step.path.length === 0) return null;
            return (
                <Polyline
                    key={index}
                    coordinates={step.path.map((p: any) => ({ latitude: p.lat, longitude: p.lng }))}
                    strokeColor={style.color}
                    strokeWidth={style.width}
                    lineDashPattern={style.dash}
                    zIndex={step.is_transit ? 10 : 1}
                />
            );
        })}
        
        {(screen === 'search' && allRoutes.length > 0) && (
             <Polyline coordinates={allRoutes[0].path.map((p: any) => ({ latitude: p.lat, longitude: p.lng }))} strokeColor="#9ca3af" strokeWidth={3} lineDashPattern={[5,5]}/>
        )}
      </MapView>
 
      {screen === 'live' && (
          <TouchableOpacity style={styles.gpsButton} onPress={recenterMap}>
            <Navigation color="#2563EB" size={24} fill="#2563EB" />
          </TouchableOpacity>
      )}
 
      {/* --- SEARCH OVERLAY --- */}
      {screen === 'search' && (
          <SafeAreaView style={styles.overlay}>
            <View style={styles.card}>
                <Text style={styles.title}>Boston Transit</Text>
                <TextInput style={styles.input} placeholder="Start (e.g. Harvard)" value={origin} onChangeText={setOrigin} />
                <TextInput style={styles.input} placeholder="End (e.g. South Station)" value={destination} onChangeText={setDestination} />
                
                <View style={styles.speedRow}>
                    {['slow', 'normal', 'fast'].map(s => (
                        <TouchableOpacity key={s} onPress={() => setWalkingSpeed(s)}
                            style={[styles.speedBtn, walkingSpeed === s && styles.activeSpeed]}>
                            <Text style={{textTransform:'capitalize', color: walkingSpeed===s?'white':'black'}}>{s}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
                
                <TouchableOpacity style={styles.mainBtn} onPress={handleSearch} disabled={loading}>
                    {loading ? <ActivityIndicator color="#fff"/> : <Text style={styles.btnText}>Find Routes</Text>}
                </TouchableOpacity>
            </View>
            {allRoutes.length > 0 && (
                <View style={styles.routeListContainer}>
                    <Text style={styles.listHeader}>Select a Route:</Text>
                    <FlatList
                        data={allRoutes}
                        keyExtractor={(_,i) => i.toString()}
                        renderItem={({item}) => (
                            <TouchableOpacity style={styles.routeCard} onPress={() => startLiveNavigation(item)}>
                                <View style={styles.routeRow}>
                                    <View style={{flex: 1}}>
                                        <Text style={styles.routeTime}>{item.duration}</Text>
                                        <Text style={styles.routeSummary}>{item.summary}</Text>
                                    </View>
                                    <View style={[styles.confBadge, {backgroundColor: getConfidenceColor(item.catch_confidence)}]}>
                                        <Text style={styles.confText}>{item.catch_confidence === 'high' ? 'Safe' : 'Tight'}</Text>
                                    </View>
                                </View>
                            </TouchableOpacity>
                        )}
                    />
                </View>
            )}
          </SafeAreaView>
      )}
 
      {/* --- LIVE SHEET --- */}
      {screen === 'live' && activeRoute && (
          <>
            <SafeAreaView style={styles.liveHeader}>
                <TouchableOpacity onPress={exitLiveNavigation} style={styles.backBtn}>
                    <ArrowLeft color="black" size={24}/>
                </TouchableOpacity>
                <View style={[styles.confBadge, {backgroundColor: getConfidenceColor(liveConfidence)}]}>
                    <Text style={styles.confText}>{liveConfidence.toUpperCase()}</Text>
                </View>
            </SafeAreaView>
 
            <Animated.View style={[styles.bottomSheet, { height: SHEET_MAX_HEIGHT, transform: [{ translateY: panY }] }]}>
                <View style={styles.sheetHandleArea} {...panResponder.panHandlers}>
                    <View style={styles.dragPill} />
                    <Text style={styles.sheetTitle}>{isSheetExpanded ? "Full Itinerary" : "Swipe up for details"}</Text>
                </View>
 
                <View style={styles.sheetContent}>
                     {transferUpdate !== '' && (
                       <View style={[styles.updateBox, {backgroundColor: liveConfidence === 'low' ? '#FFEBEE' : '#E0F2F1'}]}>
                           <View style={{flexDirection:'row', alignItems:'center', justifyContent:'center'}}>
                               <Info size={16} color={liveConfidence === 'low' ? '#C62828' : '#00695C'} style={{marginRight:5}} />
                               <Text style={[styles.updateText, {color: liveConfidence === 'low' ? '#C62828' : '#00695C'}]}>{transferUpdate}</Text>
                           </View>
                           {(liveConfidence === 'low' || liveConfidence === 'medium') && (
                               <TouchableOpacity style={styles.rerouteBtn} onPress={handleReroute} disabled={isRerouting}>
                                   {isRerouting ? <ActivityIndicator color="white" size="small"/> : <Text style={styles.rerouteText}>Find Alternatives</Text>}
                               </TouchableOpacity>
                           )}
                       </View>
                     )}
 
                     {showAlternatives ? (
                         <View style={{flex: 1}}>
                             <Text style={styles.listHeader}>Select New Route:</Text>
                             <FlatList
                                data={alternatives}
                                keyExtractor={(_, i) => i.toString()}
                                renderItem={({item}) => (
                                     <TouchableOpacity style={styles.routeCard} onPress={() => selectAlternative(item)}>
                                         <View style={styles.routeRow}>
                                             <View style={{flex: 1}}>
                                                 <Text style={styles.routeTime}>{item.duration}</Text>
                                                 <Text style={styles.routeSummary}>{item.summary}</Text>
                                             </View>
                                             <View style={[styles.confBadge, {backgroundColor: getConfidenceColor(item.catch_confidence)}]}>
                                                 <Text style={styles.confText}>{item.catch_confidence === 'high' ? 'Safe' : 'Tight'}</Text>
                                             </View>
                                         </View>
                                     </TouchableOpacity>
                                )}
                             />
                             <TouchableOpacity style={{marginTop: 15, alignSelf:'center', padding: 10}} onPress={() => setShowAlternatives(false)}>
                                 <Text style={{color: '#666', fontWeight:'bold'}}>Cancel Reroute</Text>
                             </TouchableOpacity>
                         </View>
                     ) : (
                         <FlatList
                            data={activeRoute.steps}
                            keyExtractor={(_, i) => i.toString()}
                            contentContainerStyle={{paddingBottom: 50}}
                            renderItem={({item, index}) => {
                                if(item.is_transit) {
                                    return (
                                        <View style={styles.timelineItem}>
                                            <View style={styles.timelineLeft}>
                                                <Text style={styles.timeLabel}>{formatTime(item.departure_time)}</Text>
                                                <View style={styles.lineBar} />
                                                <Text style={styles.timeLabel}>{formatTime(item.arrival_time)}</Text>
                                            </View>
                                            <View style={styles.timelineIconContainer}>
                                                <TrainFront size={20} color="#2563EB" />
                                            </View>
                                            <View style={styles.timelineContent}>
                                                <Text style={styles.timelineTitle}>Ride Train</Text>
                                                <Text style={styles.timelineDesc}>{item.instruction.replace(/<[^>]*>?/gm, '')}</Text>
                                                
                                                {/* TEXT-ONLY ACCESSIBILITY INFO */}
                                                {item.accessibility_info && (
                                                    <Text style={{fontSize: 12, color: '#10B981', marginTop: 4}}>
                                                        {item.accessibility_info}
                                                    </Text>
                                                )}
                                            </View>
                                        </View>
                                    );
                                }
                                return (
                                    <View style={styles.timelineItem}>
                                        <View style={styles.timelineLeft}>
                                             <Text style={styles.timeLabel}></Text> 
                                        </View>
                                        <View style={styles.timelineIconContainer}>
                                            {index === 0 ? <Navigation size={20} color="#666"/> : <Footprints size={20} color="#666" />}
                                        </View>
                                        <View style={styles.timelineContent}>
                                            <Text style={styles.timelineTitle}>{index === 0 ? "Start" : "Walk / Transfer"}</Text>
                                            <Text style={styles.timelineDesc}>{item.instruction.replace(/<[^>]*>?/gm, '')}</Text>
                                        </View>
                                    </View>
                                );
                            }}
                         />
                     )}
                </View>
            </Animated.View>
          </>
      )}
    </View>
  );
}
 
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  map: { ...StyleSheet.absoluteFillObject },
  
  overlay: { flex: 1, padding: 20, justifyContent: 'space-between' },
  card: { backgroundColor: 'white', padding: 16, borderRadius: 16, elevation: 10, shadowColor:'#000', shadowOpacity:0.1 },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  input: { backgroundColor: '#F3F4F6', padding: 12, borderRadius: 8, marginBottom: 10 },
  speedRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  speedBtn: { flex: 1, alignItems: 'center', padding: 8, backgroundColor: '#eee', borderRadius: 8, marginHorizontal: 2 },
  activeSpeed: { backgroundColor: '#2563EB' },
  mainBtn: { backgroundColor: '#2563EB', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  routeListContainer: { backgroundColor: 'white', borderRadius: 16, padding: 16, maxHeight: '45%' },
  listHeader: { fontWeight: 'bold', marginBottom: 10, color: '#666' },
  routeCard: { padding: 12, borderBottomWidth: 1, borderColor: '#eee' },
  routeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  routeTime: { fontSize: 18, fontWeight: 'bold' },
  routeSummary: { fontSize: 12, color: '#666' },
  
  liveHeader: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 60, zIndex: 10 },
  backBtn: { padding: 10, backgroundColor: 'white', borderRadius: 20, elevation: 5, shadowColor:'#000', shadowOpacity:0.2 },
  confBadge: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, elevation: 5, shadowColor:'#000', shadowOpacity:0.2 },
  confText: { color: 'white', fontWeight: 'bold', fontSize: 12 },
 
  bottomSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'white', borderTopLeftRadius: 24, borderTopRightRadius: 24, shadowColor: "#000", shadowOffset: { width: 0, height: -3 }, shadowOpacity: 0.1, shadowRadius: 5, elevation: 20, zIndex: 20 },
  sheetHandleArea: { alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  dragPill: { width: 40, height: 5, backgroundColor: '#ddd', borderRadius: 10, marginBottom: 5 },
  sheetTitle: { fontWeight: 'bold', color: '#666', fontSize: 14 },
  sheetContent: { flex: 1, padding: 20 },
 
  updateBox: { padding: 12, borderRadius: 8, marginBottom: 15 },
  updateText: { fontWeight: 'bold', textAlign: 'center' },
  rerouteBtn: { marginTop: 10, backgroundColor: '#DA291C', paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  rerouteText: { color: 'white', fontWeight: 'bold', fontSize: 14 },
 
  timelineItem: { flexDirection: 'row', marginBottom: 20 },
  timelineLeft: { width: 60, alignItems: 'flex-end', marginRight: 10 },
  timeLabel: { fontSize: 12, fontWeight: 'bold', color: '#666' },
  lineBar: { width: 2, flex: 1, backgroundColor: '#ddd', marginVertical: 4, alignSelf: 'flex-end', marginRight: 0 },
  timelineIconContainer: { alignItems: 'center', marginRight: 10 },
  timelineContent: { flex: 1, justifyContent: 'center' },
  timelineTitle: { fontWeight: 'bold', fontSize: 16, marginBottom: 2 },
  timelineDesc: { color: '#555', fontSize: 14 },
  trainMarker: { padding: 6, borderRadius: 12, borderWidth: 2, borderColor: 'white', elevation: 5 },
  
  gpsButton: {
      position: 'absolute',
      right: 20,
      bottom: SHEET_MIN_HEIGHT + 20,
      backgroundColor: 'white',
      padding: 12,
      borderRadius: 30,
      elevation: 5,
      shadowColor: '#000',
      shadowOpacity: 0.2,
      zIndex: 15
  },
});